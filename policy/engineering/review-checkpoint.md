# Review Checkpoint

Before returning the verdict:

- challenge the actual implementation, not the planner's intent;
- check whether the real general problem was solved without speculative abstraction;
- check responsibility/dependency direction, source-of-truth integrity, ownership/lifecycle, and preserved contracts;
- distinguish a concrete defect from a valid alternative design;
- request a fix only for blocking/major issues, not taste or optional cleanup;
- independently check important acceptance criteria and significant missing negative, boundary, integration or lifecycle coverage, without inventing requirements;
- when the reported cause is uncertain and a plausible alternative changes the verdict, seek evidence that distinguishes them instead of accepting the first explanation;
- distinguish observed/reproduced failures, source-supported deductions, hypotheses and unverified tests; make findings traceable to actual evidence, and preserve significant related defects even if their repair is outside scope.
