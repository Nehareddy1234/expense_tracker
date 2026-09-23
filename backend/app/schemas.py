"""Pydantic request/response models. All money fields are integer paise."""

from datetime import date
from typing import Literal

from pydantic import BaseModel, Field, model_validator

CategoryType = Literal["locked", "flexible"]


class CategoryIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    type: CategoryType
    flexibility: int = Field(ge=0, le=100)
    pain_weight: int = Field(ge=1, le=10)


class CategoryPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=60)
    type: CategoryType | None = None
    flexibility: int | None = Field(default=None, ge=0, le=100)
    pain_weight: int | None = Field(default=None, ge=1, le=10)


class CategoryOut(BaseModel):
    id: int
    name: str
    type: CategoryType
    flexibility: int
    pain_weight: int
    archived: bool
    created_at: str


class SplitIn(BaseModel):
    """One share of an income split. category_id None = Unallocated.
    Provide exactly one of amount_paise / percent."""

    category_id: int | None = None
    amount_paise: int | None = Field(default=None, ge=0)
    percent: float | None = Field(default=None, gt=0, le=100)

    @model_validator(mode="after")
    def one_of_amount_or_percent(self):
        if (self.amount_paise is None) == (self.percent is None):
            raise ValueError("Provide exactly one of amount_paise or percent")
        return self


class IncomeIn(BaseModel):
    amount_paise: int = Field(gt=0)
    income_date: date
    note: str | None = None
    splits: list[SplitIn] = []
    template_id: int | None = None

    @model_validator(mode="after")
    def splits_or_template(self):
        if self.template_id is not None and self.splits:
            raise ValueError("Provide either splits or template_id, not both")
        return self


class SplitOut(BaseModel):
    category_id: int | None
    category_name: str
    amount_paise: int


class IncomeOut(BaseModel):
    id: int
    amount_paise: int
    note: str | None
    income_date: str
    created_at: str
    splits: list[SplitOut]
    unallocated_paise: int


class TemplateIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    items: list[SplitIn] = Field(min_length=1)

    @model_validator(mode="after")
    def percent_only(self):
        for it in self.items:
            if it.percent is None:
                raise ValueError("Template items must use percent")
        total = sum(it.percent for it in self.items)
        if total > 100 + 1e-9:
            raise ValueError(f"Template percentages must sum to <= 100 (got {total})")
        return self


class TemplateOut(BaseModel):
    id: int
    name: str
    created_at: str
    items: list[dict]  # [{category_id, category_name, percent}]


class ExpenseIn(BaseModel):
    category_id: int
    amount_paise: int = Field(gt=0)
    description: str | None = None
    expense_date: date


class ExpenseOut(BaseModel):
    id: int
    category_id: int
    category_name: str
    amount_paise: int
    description: str | None
    expense_date: str
    created_at: str


class MoveIn(BaseModel):
    category_id: int
    amount_paise: int = Field(gt=0)


class RebalanceIn(BaseModel):
    moves: list[MoveIn] = Field(min_length=1)
