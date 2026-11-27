"""Input to the AI: a description of the form and what the user already typed."""
from typing import Optional
from pydantic import BaseModel, Field


class FormField(BaseModel):
    name: str
    label: str
    type: str = "text"            # text | number | select | date
    required: bool = False
    options: list[str] = Field(default_factory=list)


class FormContext(BaseModel):
    formTitle: str
    fields: list[FormField]
    values: dict[str, str] = Field(default_factory=dict)   # already typed by user
    frictionField: Optional[str] = None                    # where user struggled
    frictionReason: Optional[str] = None
