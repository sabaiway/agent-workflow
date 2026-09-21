# Task: {{TASK_NAME}}
Story: {{STORY_ID}} of {{EPIC_ID}}

## Slice
Plan: {{PLAN_PATH}}
Row: {{ROW_ID}}
Grouping: test, impl
Files:
- {{TEST_PATH}} :: test
- {{MODULE_PATH}} :: impl

## Reads
- {{PLAN_PATH}}

## Acceptance
- {{ACCEPTANCE_COMMAND}} :: {{EXPECTED_OUTCOME}}

## Negative cases
- {{NEGATIVE_CASE}} :: {{NEGATIVE_OUTCOME}}

## Budget
- {{TEST_PATH}} :: {{TEST_MAX_LINES}}
- {{MODULE_PATH}} :: {{MODULE_MAX_LINES}}
