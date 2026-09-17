-- ASK FOR IT SEPARATELY IN THE FIRST PLACE -- THE CHEAP HALF OF THE PACKET
-- PROBLEM.
--
-- Migration 0118 is the expensive half: a supplier sent 25 documents in one
-- PDF, and dox now detects that, proposes ranges and lets a human split it.
-- Everything about that is recovery. The cheap half is not needing it: when we
-- ASK for the documents, say that each one must arrive as its own file.
--
-- WHY A COLUMN AND NOT FREE TEXT. request_lines already has
-- `acceptable_formats` and `criteria`, and "please send each document as a
-- separate PDF" fits in either of them -- as prose. Prose is unqueryable, gets
-- worded differently by every author, is not rendered anywhere in particular,
-- and cannot be counted when someone asks "which of our asks said this and did
-- the supplier honour it". The same argument migration 0090 made for
-- `line_kind`: an ask a machine cannot read is an ask the registry cannot
-- reason about. So it is a flag, and `acceptable_formats` goes back to being
-- about FORMATS (PDF, signed scan) rather than about packaging.
--
-- DEFAULT 0, and that is not a neutral choice. Combining is what suppliers
-- already do; turning this on everywhere by fiat would put a demand in every
-- issued request that nobody at this end decided to make, on lines where a
-- single document is what was asked for anyway and the sentence would be
-- noise. It is per LINE rather than per request for the same reason: "one COA
-- per lot, as its own file" is a real instruction, and "your annual statement
-- pack" on the next line is genuinely one document.
--
-- NOT NULL DEFAULT 0 rather than nullable: there is no third state here. Either
-- we said it or we did not, and a NULL would only invite "unspecified" to grow
-- a meaning later.
--
-- Mirrored onto request_template_lines because a template that cannot carry the
-- instruction silently drops it every time a request is drafted from one --
-- which is the path most requests will come through.

ALTER TABLE request_lines
  ADD COLUMN one_document_per_file INTEGER NOT NULL DEFAULT 0;

ALTER TABLE request_template_lines
  ADD COLUMN one_document_per_file INTEGER NOT NULL DEFAULT 0;
