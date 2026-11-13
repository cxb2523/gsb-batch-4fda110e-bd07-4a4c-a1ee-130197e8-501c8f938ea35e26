"""SourceBoard 的路径和配置。

钥匙和设置放在本机一个配置文件里（默认 ~/.config/sourceboard/config.env，权限 600），
抓回来的数据、花费账本、看板都放在一个数据目录里（默认 ~/SourceBoard）。
两个位置都可以用环境变量改：SOURCEBOARD_CONFIG_DIR、SOURCEBOARD_HOME。
"""
import os
from pathlib import Path

LIB = Path(__file__).resolve().parent
CONFIG_DIR = Path(os.environ.get('SOURCEBOARD_CONFIG_DIR') or Path.home() / '.config' / 'sourceboard').expanduser()
ENV_FILE = CONFIG_DIR / 'config.env'
TIKHUB_HOSTS = ('api.tikhub.io', 'api.tikhub.dev')
DEFAULT_BASE = 'https://api.tikhub.io'


def load_env():
    """读配置文件，返回 {名字: 值}；文件不存在返回空字典。不打印任何值。"""
    cfg = {}
    try:
        for line in ENV_FILE.read_text(encoding='utf-8').splitlines():
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                cfg[k.strip()] = v.strip().strip('"').strip("'")
    except OSError:
        pass
    return cfg


def get(name, default=''):
    """环境变量优先，其次配置文件。"""
    return os.environ.get(name) or load_env().get(name) or default


def save(values):
    """把若干设置写进配置文件（保留其他行），权限 600。"""
    cfg = load_env()
    cfg.update({k: v for k, v in values.items() if v is not None})
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    tmp = ENV_FILE.with_suffix('.tmp')
    tmp.write_text('# SourceBoard 本机配置。这里有钥匙，不要提交、不要发给别人。\n'
                   + ''.join(f'{k}={v}\n' for k, v in sorted(cfg.items())), encoding='utf-8')
    os.chmod(tmp, 0o600)
    tmp.replace(ENV_FILE)


def home():
    """数据目录：抓回的内容、账本、看板都在这里。

    默认 ~/SourceBoard。macOS 默认的磁盘不分大小写，如果程序本身就克隆在 ~/sourceboard，
    两者其实是同一个目录，数据会写进程序目录里；这时自动改用 ~/SourceBoard-data。
    """
    chosen = get('SOURCEBOARD_HOME')
    if chosen:
        return Path(chosen).expanduser()
    default = Path.home() / 'SourceBoard'
    program = LIB.parent.resolve()
    same = str(default).lower() == str(program).lower()
    try:
        same = same or (default.exists() and os.path.samefile(default, program))
    except OSError:
        pass
    return Path.home() / 'SourceBoard-data' if same else default


def sub(name):
    path = home() / name
    path.mkdir(parents=True, exist_ok=True)
    return path


def tikhub_base():
    """TikHub 接口地址。国内网络可在配置里把 TIKHUB_BASE_URL 设为 https://api.tikhub.dev。"""
    base = (get('TIKHUB_BASE_URL') or DEFAULT_BASE).rstrip('/')
    check_base(base)
    return base


def check_base(base):
    from urllib.parse import urlsplit
    u = urlsplit(base)
    if u.scheme != 'https' or u.hostname not in TIKHUB_HOSTS:
        raise ValueError('TikHub 地址只能是 https://api.tikhub.io 或 https://api.tikhub.dev；钥匙不会发到别的地址')


def which(name):
    """在 PATH 和常见安装位置里找外部命令，找不到返回空字符串。"""
    import shutil
    found = shutil.which(name)
    if found:
        return found
    for folder in (Path.home() / '.local/bin', Path('/opt/homebrew/bin'), Path('/usr/local/bin')):
        if (folder / name).is_file() and os.access(folder / name, os.X_OK):
            return str(folder / name)
    return ''
