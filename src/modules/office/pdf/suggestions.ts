import type { OfficeAgentSuggestions } from "../shared/types";

/** Starter prompts for the PDF assistant, per mode (client-safe; the agent module re-exports them). */
export const PDF_SUGGESTIONS: OfficeAgentSuggestions = {
  draft: [
    "Bates-stamp ABC-0000001 onward, bottom right",
    "Find every SSN, DOB, account number, e-mail and phone number and redact them",
    "Highlight every mention of MW-7 and add a note",
    "Bookmark each section heading",
    "Fill the acknowledgment form and flatten it",
    "Split pages 1-3 into a new PDF",
    "Draft a privilege log entry for this document",
  ],
  review: [
    "Check for unredacted PII and privilege markers",
    "Is this ready to produce? Check Bates, legends and redactions",
    "Flag every deadline and who owns it",
    "Highlight every defined term that is used before it is defined",
  ],
  ask: [
    "Summarize this with page citations",
    "What does paragraph 12 require? Quote it",
    "Which pages mention the substantial-risk notice?",
    "Extract the table on page 3",
  ],
};
