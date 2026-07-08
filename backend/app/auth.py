"""Auth seam for the future hosted/multi-user mode.

Every route scopes its queries by `current_user.id` (see api/routes/*), so
switching AUTH_MODE from "none" to a real "multiuser" implementation later
only means replacing get_current_user() with one that reads a session/token
- no query rewrites anywhere else.
"""

from fastapi import Depends
from sqlalchemy.orm import Session

from app.config import settings
from app.db.models import User
from app.db.session import get_db

LOCAL_USER_ID = 1
LOCAL_USERNAME = "local"


def get_current_user(db: Session = Depends(get_db)) -> User:
    if settings.auth_mode != "none":
        raise NotImplementedError("auth_mode 'multiuser' is not implemented yet")

    user = db.get(User, LOCAL_USER_ID)
    if user is None:
        user = User(id=LOCAL_USER_ID, username=LOCAL_USERNAME)
        db.add(user)
        db.commit()
        db.refresh(user)
    return user
