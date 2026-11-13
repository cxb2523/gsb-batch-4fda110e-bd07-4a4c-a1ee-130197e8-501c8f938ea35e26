"""Optional enrichments and public media processing, using existing local tools."""
import concurrent.futures
import json
from pathlib import Path
import subprocess
import threading
import time
from urllib.parse import urlsplit
import core
import paid
import incidents

DY_VIEWS = '/api/v1/douyin/app/v3/fetch_video_statistics'
XHS_READS = '/api/v1/xiaohongshu/pgy/get_note_detail'
FFMPEG = '/opt/homebrew/bin/ffmpeg'
FFPROBE = '/opt/homebrew/bin/ffprobe'


def douyin_views(results):
    for offset in range(0,len(results),2):
        group=results[offset:offset+2]
        try:
            d=paid.call(DY_VIEWS,{'aweme_ids':','.join(r.id for r in group)})
            nodes=list(paid.walk(d))
            for r in group:
                node=next((n for n in nodes if str(n.get('aweme_id',n.get('item_id',''))) == r.id and 'play_count' in n), None)
                if node is None and len(group)==1: node=next((n for n in nodes if 'play_count' in n), None)
                if node is None:
                    incidents.schema('douyin','stats',DY_VIEWS)
                    raise core.Fail('响应未返回对应作品的play_count，不能填0')
                r.stats['views']=node['play_count']
                r.stats_sources['views']='TikHub '+DY_VIEWS+'（自然播放，不含投流）'
                r.extra['views_enrichment']={'status':'success','source':DY_VIEWS}
        except Exception as e:
            for r in group:
                r.extra['views_enrichment']={'status':getattr(e,'status','connector_failed'),'note':str(e),'source':DY_VIEWS}


class ViewsBatcher:
    """Pair known batch IDs before dispatch; even slow content jobs share one request."""
    def __init__(self, ids=()):
        self.lock=threading.Lock(); self.groups={};self.futures={}
        ids=list(dict.fromkeys(ids))
        for offset in range(0,len(ids),2):
            for ident in ids[offset:offset+2]: self.groups[ident]=ids[offset:offset+2]

    def add(self,res):
        with self.lock:
            ids=self.groups.get(res.id,[res.id]); leader=res.id not in self.futures
            if leader:
                for ident in ids:self.futures[ident]=concurrent.futures.Future()
            future=self.futures[res.id]
        if leader:
            try:
                group=[]
                for ident in ids:
                    r=core.Result('douyin','');r.id=ident;group.append(r)
                douyin_views(group)
                source=str(core.CURRENT.get().out)
                for r in group:
                    r.extra['views_enrichment']['shared_request_package']=source
                    self.futures[r.id].set_result(r)
            except BaseException as e:
                for ident in ids:self.futures[ident].set_exception(e)
                raise
        enriched=future.result(timeout=130)
        res.stats.update(enriched.stats);res.stats_sources.update(enriched.stats_sources)
        res.extra.update(enriched.extra)


def xhs_reads(res):
    try:
        d=paid.call(XHS_READS,{'note_id':res.id},method='post')
        node=next((n for n in paid.walk(d) if 'readNum' in n or 'impNum' in n),{})
        if node.get('readNum')==0 and node.get('impNum')==0 and any(res.stats.get(k,0)>0 for k in ('likes','comments','collects')):
            res.extra['reads_enrichment']={'status':'index_partial','note':'蒲公英全部阅读/曝光为0，但实时互动非零；无法区分未覆盖与延迟，不把占位0当真实阅读。','source':XHS_READS,'reported':{'readNum':0,'impNum':0}}
            return
        for key,field in (('reads','readNum'),('impressions','impNum')):
            if node.get(field) is not None:
                res.stats[key]=node[field]
                res.stats_sources[key]='TikHub 蒲公英 '+XHS_READS+'（有延迟）'
        status='success' if all(k in res.stats for k in ('reads','impressions')) else 'index_partial' if node else 'not_attempted'
        res.extra['reads_enrichment']={'status':status,'note':'来自蒲公英，有延迟；覆盖不到的笔记不填0，不替换实时互动数','source':XHS_READS}
    except Exception as e:
        res.extra['reads_enrichment']={'status':getattr(e,'status','connector_failed'),'note':str(e),'source':XHS_READS}


def probe(path):
    p=subprocess.run([FFPROBE,'-v','error','-show_entries','stream=codec_type,codec_name:format=duration,size','-of','json',str(path)],capture_output=True,text=True,env=core.SAFE_ENV,timeout=30)
    if p.returncode: raise core.Fail('ffprobe无法确认音视频流')
    return json.loads(p.stdout)


def mux(video,audio,target,expected_duration=None):
    target=core.external_path(target)
    part=target.with_name(target.stem+'.part.mp4')
    try:
        p=subprocess.run([FFMPEG,'-nostdin','-v','error','-y','-i',str(video),'-i',str(audio),'-map','0:v:0','-map','1:a:0','-c','copy','-movflags','+faststart',str(part)],capture_output=True,text=True,env=core.SAFE_ENV,timeout=300)
        if p.returncode: raise core.Fail('ffmpeg合轨失败：'+p.stderr[-400:])
        data=probe(part)
        if not {'video','audio'}.issubset({s['codec_type'] for s in data['streams']}): raise core.Fail('合轨产物缺音频或视频')
        if expected_duration and float(data.get('format',{}).get('duration',0)) < float(expected_duration)*.98:
            raise core.Fail('合轨时长不足原片98%，拒绝把截断片段当完整视频')
        part.replace(target)
        return str(target),data
    finally:
        if part.exists(): part.unlink()


def bili_media(res,dest):
    """Use documented public DASH addresses; HTTP fetches retain existing size limits."""
    pairs=res.extra.get('dash_pairs',[])
    if not pairs:
        info=core.CURRENT.get().ytdlp
        if not info:
            try: info=core.ytdlp_info(res.url)
            except Exception: info={}
        formats=info.get('formats') or []
        vs=[f for f in formats if f.get('vcodec') not in (None,'none') and f.get('acodec')=='none' and f.get('url','').startswith('http')]
        aus=[f for f in formats if f.get('acodec') not in (None,'none') and f.get('vcodec')=='none' and f.get('url','').startswith('http')]
        if vs and aus:
            # Select alternate CDN URLs that were actually returned, never invent mirrors.
            audio=max(aus,key=lambda f:f.get('abr') or 0)['url']; hosts=set();pairs=[]
            for v in sorted(vs,key=lambda f:f.get('height') or 0,reverse=True):
                host=urlsplit(v['url']).hostname
                if host not in hosts:
                    hosts.add(host);pairs.append({'video':v['url'],'audio':audio,'height':v.get('height')})
    if not pairs and not core.CURRENT.get().no_paid and res.extra.get('cid'):
        d=paid.call('/api/v1/bilibili/web/fetch_video_playurl',{'bv_id':res.id,'cid':res.extra['cid']})
        for n in paid.walk(d):
            dash=n.get('dash')
            if isinstance(dash,dict) and dash.get('video') and dash.get('audio'):
                v=max(dash['video'],key=lambda x:x.get('bandwidth') or 0); a=max(dash['audio'],key=lambda x:x.get('bandwidth') or 0)
                videos=list(dict.fromkeys([v.get('baseUrl',v.get('base_url'))]+(v.get('backupUrl') or v.get('backup_url') or [])))
                audios=list(dict.fromkeys([a.get('baseUrl',a.get('base_url'))]+(a.get('backupUrl') or a.get('backup_url') or [])))
                pairs=[{'video':vu,'audio':next((au for au in audios if urlsplit(au).hostname==urlsplit(vu).hostname),audios[0]),'height':v.get('height')} for vu in videos if vu]
                break
        if not pairs and not any('dash' in n or 'durl' in n for n in paid.walk(d)):
            incidents.schema('bilibili','media','/api/v1/bilibili/web/fetch_video_playurl',str(d))
    if not pairs: return False
    errors=[]
    for i,pair in enumerate(pairs):
        v=a=None
        try:
            v=Path(core.download(pair['video'],dest/f'bili-{i}-video.m4s',referer=res.url,chunk_bytes=512*1024))
            a=Path(core.download(pair['audio'],dest/f'bili-{i}-audio.m4s',referer=res.url,chunk_bytes=512*1024))
            final,data=mux(v,a,dest/'bilibili.mp4',res.extra.get('duration'))
            res.media_files.append(final);res.extra['ffprobe']=data
            res.extra['media_download']={'height':pair.get('height'),'video_cdn':urlsplit(pair['video']).hostname,'prior_errors':errors}
            return True
        except Exception as e:errors.append(str(e))
        finally:
            for track in (v,a):
                if track and track.exists():track.unlink()
    raise core.Fail('公开DASH下载失败：'+'; '.join(errors))



def download_video(res, url, target):
    """Download one public video for --with-media."""
    if res.platform != 'wechat_channels':
        return core.download(url,target,ua=core.UA_ANDROID if res.platform=='douyin' else core.UA_DESKTOP,referer=res.url)
    raise core.Fail('开源版不带视频号视频下载；正文、作者和互动数照常可用，原视频请点原链接看', 'not_attempted')
