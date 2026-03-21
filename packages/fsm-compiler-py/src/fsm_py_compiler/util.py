import re
from datetime import datetime
from typing import Literal

WorkflowType = Literal["fsm", "sharedFsm", "sharedPromise", "promise"]


def is_version_folder_name(name: str) -> bool:
    """
    Return True if name matches the vNN pattern (v00–v99).
    Mirrors isVersionFolderName() in util.ts.
    """
    return bool(re.fullmatch(r"v\d{2}", name))


def is_timestamp_folder_name(name: str) -> bool:
    """
    Return True if name is a 14-digit timestamp (YYYYMMDDHHMMSS).
    Mirrors isTimestampFolderName() in util.ts.
    """
    return bool(re.fullmatch(r"\d{14}", name))


def is_valid_date_folder_name(name: str) -> bool:
    """
    Return True if name matches YYYY-MM-DD-HH-MM with a valid calendar date.
    Mirrors isValidDateFolderName() in util.ts.
    """
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}-\d{2}-\d{2}", name):
        return False
    try:
        parts = name.split("-")
        year, month, day, hour, minute = (int(p) for p in parts)
        datetime(year, month, day, hour, minute)
        return True
    except ValueError:
        return False
