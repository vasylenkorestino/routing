# Route Generation Task

Generate optimized Google routes from candidate accounts.
Return structured JSON only — no conversational filler.
Respect truck capacity, shift hours, geographic clustering, and yard rules.

ACCOUNT SELECTION (mandatory):
- ALWAYS call service_due_analysis first to determine which accounts actually require
  service in the planning window. Only include accounts it reports as due.
- Do NOT include every UCO Collection account. An account is due only when its last
  UCO service date plus its pickup frequency lands on or before the target date
  (service_due_analysis resolves both, falling back to Service__c history when the
  Account fields are empty).
- Never create or update Salesforce records while determining eligibility.
