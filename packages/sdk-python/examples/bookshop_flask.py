"""示例书店的 Flask 版本：flask --app examples.bookshop_flask run（在 packages/sdk-python 目录下）。"""

from flask import Flask

from ai_relay_sdk.flask import register_relay

from .bookshop import create_relay

app = Flask(__name__)
register_relay(app, create_relay())
