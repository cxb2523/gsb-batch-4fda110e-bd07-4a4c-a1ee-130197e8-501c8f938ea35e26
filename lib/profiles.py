"""Public account profiles and recent works; no per-item detail fan-out by default."""
import json
import re
import sys
from urllib.parse import urlsplit, unquote
import core
import paid
import routes


def number(value):
    if value is None or value == '': return None
    try: return int(str(value).replace(',',''))
    except (ValueError,TypeError): return value


def normalize_profile(platform, ident, doc):
    nodes=list(paid.walk(doc))
    markers={'douyin':('follower_count','aweme_count'),'tiktok':('follower_count','aweme_count'),
             'xiaohongshu':('fans','fans_count','fansCount','followers','red_id'),
             'bilibili':('mid','uname','follower'),'instagram':('follower_count','followers_count','edge_followed_by'),
             'x':('followers_count','screen_name','sub_count','rest_id')}
    candidates=[n for n in nodes if any(k in n for k in markers[platform])]
    v=max(candidates,key=lambda n:sum(k in n for k in markers[platform]),default={})
    if not v:
        import incidents
        incidents.schema(platform,'profile',routes.PROFILES[platform][0],str(doc))
        raise core.Fail('quality_gate: 未识别公开账号资料')
    # Some APIs separate user identity and follower counters in adjacent objects.
    def get(*keys):
        value=paid.pick(v,*keys)
        if value is not None: return value
        return next((paid.pick(n,*keys) for n in nodes if paid.pick(n,*keys) is not None),None)
    def metric(*keys):
        val=get(*keys)
        if isinstance(val,dict): val=paid.pick(val,'count','like_num')
        return number(val)
    def image(value):
        if isinstance(value,dict): return (value.get('url_list') or [value.get('url')])[0]
        return value if isinstance(value,str) else None
    verified=get('verified_reason','custom_verify','enterprise_verify_reason','verification','verification_type','verified','is_verified','official_verify','official','red_official_verify_content','red_official_verified')
    p={'id':str(get('uid','user_id','id_str','rest_id','mid','id','userid') or ident), 'handle':str(get('screen_name','unique_id','username','red_id','redId','profile') or ident),
       'nickname':str(get('nickname','nick_name','name','uname','full_name','display_name','nickName') or ident),
       'bio':str(get('signature','description','desc','bio','biography','introduction','sign') or ''),
       'followers':metric('follower_count','followers_count','fans','fans_count','fansCount','followers','follower','sub_count','edge_followed_by'),
       'following':metric('following_count','follow_count','follows','following','follow','friends','attention','edge_follow'),
       'likes':metric('total_favorited','totalFavorited','liked_count','like_num','likes','likes_count','favourites_count','be_liked','liked'),
       'posts':metric('aweme_count','note_count','notes_count','ndiscovery','notes','statuses_count','media_count','video_count','video','edge_owner_to_timeline_media'),
       'verification':verified,'avatar':image(get('avatar_larger','avatar_medium','avatar','images','profile_pic_url','profile_image_url_https','face')),
       'source':'TikHub 公开主页', 'note':'未公开的字段留空。'+('X likes为公开favourites_count（账号点赞数），不是全作品获赞。' if platform=='x' else '')}
    # X GraphQL stores identity in core and counts in legacy; retain their association.
    if platform=='bilibili':
        archive=next((n.get('archive') for n in nodes if isinstance(n.get('archive'),dict)),{})
        if archive.get('count') is not None:p['posts']=archive['count']
        p['avatar']=image(get('face','avatar'))
    return p


def normalized_items(platform, doc):
    items=[]; seen=set()
    for n in paid.walk(doc):
        item=None
        if platform in ('douyin','tiktok') and n.get('aweme_id') and ('video' in n or 'desc' in n):
            ident=str(n['aweme_id']);s=n.get('statistics') or {};a=n.get('author') or {}
            handle=a.get('unique_id') or a.get('uid') or 'user'
            item={'id':ident,'title':n.get('desc',''),'published_at':core.ts(n.get('create_time')),
                  'url':f'https://www.douyin.com/video/{ident}' if platform=='douyin' else f'https://www.tiktok.com/@{handle}/video/{ident}',
                  'stats':{k:s.get(v) for k,v in (('views','play_count'),('likes','digg_count'),('comments','comment_count'),('shares','share_count'),('collects','collect_count'))}}
            cover=(n.get('video',{}).get('cover') or {}).get('url_list') or [];item['cover']=cover[0] if cover else None
            if platform=='douyin' and item['stats'].get('views')==0:
                item['stats'].pop('views');item['stats_note']='作品列表播放0不可靠；--profile-views 才补自然播放'
        elif platform=='xiaohongshu' and (n.get('note_id') or n.get('noteId') or (n.get('id') and ('display_title' in n or 'note_card' in n))):
            card=n.get('note_card') or n; ident=str(n.get('note_id') or n.get('noteId') or n.get('id'));s=card.get('interact_info') or card
            item={'id':ident,'title':paid.pick(card,'display_title','title','desc') or '', 'published_at':core.ts(paid.pick(card,'time','create_time','publish_time')),
                  'url':'https://www.xiaohongshu.com/explore/'+ident,'stats':{'likes':paid.pick(s,'liked_count','likes','likedCount'),'comments':paid.pick(s,'comment_count','comments_count'),'collects':paid.pick(s,'collected_count')}}
            image=card.get('cover') or {}; item['cover']=image.get('url_default',image.get('url')) if isinstance(image,dict) else image
        elif platform=='bilibili' and (n.get('bvid') or n.get('aid')) and 'title' in n:
            ident=n.get('bvid') or 'av'+str(n['aid']);s=n.get('stat') or n
            item={'id':str(ident),'title':n['title'],'published_at':core.ts(paid.pick(n,'created','pubdate','ctime')),
                  'url':'https://www.bilibili.com/video/'+str(ident),'cover':n.get('pic'),'stats':{'views':paid.pick(s,'play','view'),'likes':s.get('like'),'comments':paid.pick(s,'comment','reply')}}
        elif platform=='instagram' and (n.get('code') or n.get('shortcode')) and any(k in n for k in ('caption','taken_at','edge_media_to_caption','media_type')):
            ident=n.get('code') or n.get('shortcode');caption=n.get('caption') or {};text=caption.get('text','') if isinstance(caption,dict) else str(caption)
            if not text:
                edges=n.get('edge_media_to_caption',{}).get('edges') or [];text=edges[0].get('node',{}).get('text','') if edges else ''
            item={'id':ident,'title':text,'published_at':core.ts(paid.pick(n,'taken_at','taken_at_timestamp','timestamp')),
                  'url':'https://www.instagram.com/p/'+ident+'/', 'stats':{'views':paid.pick(n,'play_count','view_count','video_view_count'),'likes':n.get('like_count'),'comments':n.get('comment_count')}}
            images=(n.get('image_versions2') or {}).get('candidates') or [];item['cover']=images[0].get('url') if images else n.get('display_url')
        elif platform=='x' and (n.get('full_text') or n.get('text')) and (n.get('id_str') or n.get('tweet_id') or n.get('rest_id')):
            ident=str(n.get('id_str') or n.get('tweet_id') or n.get('rest_id'));item={'id':ident,'title':n.get('full_text') or n['text'],'published_at':core.ts(n.get('created_at')),
                'url':'https://x.com/i/status/'+ident,'stats':{'views':n.get('views'),'likes':paid.pick(n,'favorite_count','favorites'),'comments':paid.pick(n,'reply_count','replies'),'shares':paid.pick(n,'retweet_count','retweets')}}
        if item and item['id'] not in seen:
            seen.add(item['id']);item['stats']={k:number(v) for k,v in item['stats'].items() if v is not None and v!=''};items.append(item)
    return items


def official_client():
    from youtube_official import Official
    return Official(str(core.CURRENT.get().out/'official-quota'))


def youtube_channel_id(page):
    # Page-level metadata must take priority over recommended videos' channelId.
    url=core.meta_tag(page,'og:url')
    match=re.search(r'/channel/(UC[\w-]+)',url)
    match=match or re.search(r'"externalId"\s*:\s*"(UC[\w-]{22})"',page)
    if not match: raise core.Fail('公开频道页没有返回自身channelId；没有拿推荐频道代替')
    return match.group(1)


def youtube(res, ident, pages):
    c=official_client()
    if not ident.startswith('UC'):
        # Resolve only public channel ID from anonymous page, then use Official for data.
        h=core.get(res.url).text
        ident=youtube_channel_id(h)
    # Capture the Official response before its existing compact normalizer drops bio/count.
    raw_channels=[]; transport=c.transport
    def capture(endpoint,params):
        data=transport(endpoint,params)
        if endpoint=='channels':raw_channels.extend(data.get('items') or [])
        return data
    c.transport=capture
    data=c.channels([ident]); core.save_raw('youtube-profile',data)
    v=data.get('found',{}).get(ident)
    if not v: raise core.Fail('Official.channels没有返回频道：'+str(data.get('errors')))
    raw=next((x for x in raw_channels if x.get('id')==ident),{});core.save_raw('youtube-channel-public',raw)
    snippet=raw.get('snippet') or {};stats=raw.get('statistics') or {}
    res.id=ident;res.profile={'id':ident,'handle':snippet.get('customUrl') or ident,'nickname':v['title'],'bio':snippet.get('description',''),'followers':v.get('subscribers'),'following':None,'likes':None,'posts':number(stats.get('videoCount')),'verification':None,'source':'YouTube Official.channels','note':'YouTube不公开关注数、全频道获赞；隐藏订阅数留空。'}
    thumbs=snippet.get('thumbnails') or {};image=(thumbs.get('high') or thumbs.get('default') or {}).get('url')
    if image:res.images.append(image)
    token=None;fetched=0
    for _ in range(pages):
        page=c.playlist_items(v['uploads_playlist'],max_results=50,page_token=token);core.save_raw('youtube-uploads',page)
        if not page.get('ok'): raise core.Fail('Official.playlist_items失败：'+str(page.get('error')))
        fetched+=1; videos=c.videos([x['video_id'] for x in page['items']]);core.save_raw('youtube-upload-stats',videos)
        for item in page['items']:
            stat=videos.get('found',{}).get(item['video_id'],{})
            res.items.append({'id':item['video_id'],'title':item['title'],'url':'https://www.youtube.com/watch?v='+item['video_id'],'published_at':item['published_at'],'stats':{'views':stat['views']} if stat.get('views') is not None else {}})
        token=page.get('next_page_token')
        if not token: break
    res.extra['profile_pagination']={'pages_requested':pages,'pages_fetched':fetched,'has_more':bool(token)}


def scrape(res, args, ident):
    pages=args.profile_pages
    res.profile={};res.extra['kind']='profile'
    try:
        if res.platform=='youtube':
            youtube(res,ident,pages)
        else:
            if args.no_paid: raise core.Fail('--no-paid：账号主页TikHub路线已跳过', 'not_attempted')
            profile_path,items_path,key=routes.PROFILES[res.platform]
            params={key:ident}
            doc=paid.call(profile_path,params);res.profile=normalize_profile(res.platform,ident,doc)
            if res.profile.get('avatar'):res.images.append(res.profile['avatar'])
            seen=set();fetched=0;pagination=dict(params);note=''
            if res.platform=='bilibili':pagination={'uid':ident}
            for index in range(pages):
                if res.platform=='bilibili':pagination['pn']=index+1
                try:
                    d=paid.call(items_path,pagination)
                    items=normalized_items(res.platform,d)
                    if not items and not any(isinstance(n.get(k),list) and not n[k] for n in paid.walk(d) for k in ('aweme_list','notes','items','vlist','list','edges')):
                        import incidents
                        incidents.schema(res.platform,'posts',items_path,str(d))
                        raise core.Fail('quality_gate: 作品列表结构未识别，不能报零条')
                except Exception as e:
                    note=f'第{index+1}页作品失败：{e}';break
                fetched+=1
                for item in items:
                    if item['id'] not in seen: res.items.append(item);seen.add(item['id'])
                if res.platform=='bilibili':
                    if len(items)<25:break
                    continue
                curkey=paid.cursor_param(res.platform,'profile');cursor=paid.next_cursor(res.platform,d,pagination.get(curkey),'profile')
                if cursor is None: break
                pagination[curkey]=cursor
            res.extra['profile_pagination']={'pages_requested':pages,'pages_fetched':fetched,'note':note}
            if res.platform=='douyin' and args.profile_views:
                import enrich
                rs=[]
                for item in res.items:
                    r=core.Result('douyin',item['url']);r.id=item['id'];r.stats=item['stats'];rs.append(r)
                enrich.douyin_views(rs)
                for item,r in zip(res.items,rs):item['stats_sources']=r.stats_sources;item['views_enrichment']=r.extra.get('views_enrichment')
        res.title=res.author=res.profile['nickname'];res.text=res.profile.get('bio') or '公开账号资料及最近一页作品'
        res.stats={k:res.profile.get(k) for k in ('followers','following','likes','posts') if res.profile.get(k) is not None}
        res.setcap('content','index_partial' if res.extra.get('profile_pagination',{}).get('note') else 'success',res.profile['source'],res.extra.get('profile_pagination',{}).get('note','账号资料与作品列表'))
        res.setcap('comments','not_attempted','','主页不抓单条评论；评论页数开关仅适用于作品')
    except Exception as e:
        res.setcap('content',getattr(e,'status','connector_failed'),'public profile',str(e))
