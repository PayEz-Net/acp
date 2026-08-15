-- kb: add a project dimension.  2026-08-14
--
-- WHY. Session summaries were keyed by agent name alone, so an agent that worked
-- project A and was then started under project B booted holding A's next-actions
-- list -- and because a present summary is the RESUME signal, it began executing
-- it without pausing.  Agents sit on several project teams at once, so this was
-- the normal state, not an edge case.
--
-- 0 MEANS GLOBAL, matching the convention used in the application code.
--
-- Everything here is additive or reversible.  The one destructive-looking step
-- (4) sets expires_at rather than deleting: in this store expired rows stop
-- being retrieved but stay queryable, so an over-eager retirement is recoverable.

BEGIN;

-- 1 ------------------------------------------------------------------------
-- Constant default, so PG11+ records it in the catalogue rather than rewriting
-- the table.  Matters here: every agent is reading this store right now.
ALTER TABLE kb ADD COLUMN IF NOT EXISTS project_id int NOT NULL DEFAULT 0;

-- 2 ------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS kb_scope_project_idx ON kb (scope, scope_id, project_id);

-- 3 ------------------------------------------------------------------------
-- scope='project' rows ALREADY carry the project, in scope_id.  Lift it into the
-- column where it is numeric.  'payez-core' is a scope_id that is not a project
-- id, so it is deliberately left global rather than coerced into a wrong number.
UPDATE kb
   SET project_id = scope_id::int
 WHERE scope = 'project'
   AND scope_id ~ '^[0-9]+$'
   AND project_id = 0;

-- 4 ------------------------------------------------------------------------
-- Existing session summaries CANNOT be attributed to a project: nothing in the
-- write path ever recorded one.  Leaving them at 0 would be strictly worse than
-- the bug being fixed -- 0 means global, so every project would read them.
-- Retire them.  Agents cold-start once; the next shutdown writes scoped rows.
UPDATE kb
   SET expires_at = now()
 WHERE scope = 'agent'
   AND (title LIKE '%session summary%' OR title LIKE '%session dump%')
   AND expires_at IS NULL;

-- 5 ------------------------------------------------------------------------
-- kb_search gains want_project.  It CANNOT be added as an overload: the new
-- parameter has a default, so an existing 5-argument call would match both
-- signatures and Postgres would reject it as ambiguous.  DROP + CREATE inside
-- this transaction is atomic, so there is no window in which recall is broken.
--
-- The filter rule is the load-bearing part:
--     project_id = want_project OR project_id = 0
-- A project-scoped query must still see GLOBAL memories (doctrine, references).
-- want_project IS NULL means "no project filter" -- every existing caller,
-- including the kb_recall hook, keeps its present behaviour untouched.
--
-- The body below is the 2026-08-10 ranking version, unchanged except for that
-- one predicate.  The DISTINCT ON ordering is dedupe machinery, not ranking;
-- it must keep exactly this shape.
DROP FUNCTION IF EXISTS kb_search(text, vector, kb_scope, text, integer);

CREATE FUNCTION public.kb_search(
    q            text,
    q_embedding  vector  DEFAULT NULL::vector,
    want_scope   kb_scope DEFAULT NULL::kb_scope,
    want_id      text    DEFAULT NULL::text,
    k            integer DEFAULT 8,
    want_project integer DEFAULT NULL::integer
)
RETURNS TABLE(title text, chunk text, source text, scope kb_scope, scope_id text, rank real)
LANGUAGE sql
STABLE
AS $function$
  WITH q_and AS (SELECT websearch_to_tsquery('english', q) AS tq),
  q_or AS (
    SELECT to_tsquery('english',
             array_to_string(
               ARRAY(SELECT DISTINCT t FROM unnest(
                       regexp_split_to_array(lower(regexp_replace(q,'[^a-zA-Z0-9_ ]',' ','g')),'\s+')) AS t
                     WHERE length(t) > 2),
               ' | ')) AS tq
  ),
  filtered AS (
    SELECT * FROM kb
    WHERE (want_scope IS NULL OR kb.scope = want_scope)
      AND (want_id    IS NULL OR kb.scope_id = want_id)
      -- project dimension (2026-08-14). NULL = unfiltered; global (0) always visible.
      AND (want_project IS NULL OR kb.project_id = want_project OR kb.project_id = 0)
      -- expired quick notes are not memories any more (2026-08-10)
      AND (kb.expires_at IS NULL OR kb.expires_at > now())
  ),
  lex_and AS (
    SELECT f.title, f.chunk, f.source, f.scope, f.scope_id,
           (ts_rank(f.tsv, (SELECT tq FROM q_and)) + 3.0)::real AS rank
    FROM filtered f WHERE f.tsv @@ (SELECT tq FROM q_and) ORDER BY rank DESC LIMIT k
  ),
  -- RAW-TEXT identifier match: survives snake_case, [Authorize], dots, slashes.
  ident AS (
    SELECT f.title, f.chunk, f.source, f.scope, f.scope_id, 2.0::real AS rank
    FROM filtered f
    WHERE (coalesce(f.title,'') || ' ' || coalesce(f.chunk,'')) ILIKE '%' || q || '%'
    LIMIT k
  ),
  lex_or AS (
    SELECT f.title, f.chunk, f.source, f.scope, f.scope_id,
           (ts_rank(f.tsv, (SELECT tq FROM q_or)) + 1.0)::real AS rank
    FROM filtered f WHERE f.tsv @@ (SELECT tq FROM q_or) ORDER BY rank DESC LIMIT k
  ),
  semantic AS (
    SELECT f.title, f.chunk, f.source, f.scope, f.scope_id,
           (1.0 - (f.embedding <=> q_embedding))::real AS rank
    FROM filtered f WHERE q_embedding IS NOT NULL AND f.embedding IS NOT NULL
    ORDER BY f.embedding <=> q_embedding LIMIT k
  ),
  -- Inner: DISTINCT ON keeps the highest-ranked copy of each memory. Its
  -- ORDER BY is dedupe machinery and must stay exactly this shape.
  deduped AS (
    SELECT DISTINCT ON (u.title, u.chunk) u.*
    FROM (SELECT * FROM lex_and UNION ALL SELECT * FROM ident
          UNION ALL SELECT * FROM lex_or UNION ALL SELECT * FROM semantic) u
    ORDER BY u.title, u.chunk, u.rank DESC
  )
  -- Outer: the ranking the caller actually asked for, and k applied ONCE to
  -- the whole union rather than per branch.
  SELECT d.title, d.chunk, d.source, d.scope, d.scope_id, d.rank
  FROM deduped d
  ORDER BY d.rank DESC
  LIMIT k;
$function$;

COMMIT;
