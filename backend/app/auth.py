"""Single-user identity.

This is a single-user desktop app: there is exactly one local user (id=1),
seeded on first access. Routes still take `current_user` via Depends so every
owner_id-scoped query keeps working unchanged.
"""

from fastapi import Depends
from sqlalchemy.orm import Session

from app.db.models import User
from app.db.session import get_db

LOCAL_USER_ID = 1
LOCAL_USERNAME = "local"


def get_current_user(db: Session = Depends(get_db)) -> User:
    user = db.get(User, LOCAL_USER_ID)
    if user is None:
        user = User(id=LOCAL_USER_ID, username=LOCAL_USERNAME)
        db.add(user)
        db.commit()
        db.refresh(user)
    return user
