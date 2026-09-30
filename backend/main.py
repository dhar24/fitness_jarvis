import pathlib
import sys

from dotenv import load_dotenv

load_dotenv()
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent / "frontend" / "api"))

from index import app # noqa: E402,F401