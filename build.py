# build 85d088e9c9
# (auto) 083405
from pathlib import Path
from jinja2 import Environment, FileSystemLoader

ROOT=Path(__file__).parent
OUT=ROOT/'_site'

def build():
    OUT.mkdir(exist_ok=True)
    env=Environment(loader=FileSystemLoader(ROOT/'templates'))
    content=(ROOT/'content'/'index.html').read_text(encoding='utf-8')
    (OUT/'index.html').write_text(
        env.get_template('base.html').render(title='Site', content=content),
        encoding='utf-8')

if __name__ == '__main__':
    build()
