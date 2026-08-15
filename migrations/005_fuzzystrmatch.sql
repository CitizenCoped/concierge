-- 005_fuzzystrmatch.sql — phonetic/typo tolerance for guest matching.
-- STT regularly mangles surnames ("Ebsen" → "Epson"/"Edson"); exact matching
-- denied a real guest during live use. Levenshtein-based pass 3 in
-- src/lib/db/guests.ts uses this extension.

create extension if not exists fuzzystrmatch;
