-- Normalisation of the loaded law corpus (run by load_open_india_law.py after every load).

-- Law Commission of India material in the Open India Law regulator files is reports and consultation papers, not law.
-- The dataset marks every row in_force and titles most reports after their download link ("268 Accessible (Pdf 1.73Mb)",
-- "285 Click Here"). This classifies them as reports and gives link-titled reports their report number as title.
-- Idempotent; run after load_open_india_law.py (the loader also runs it).

UPDATE law_instruments SET kind = 'report', status = 'report'
WHERE regulator = 'law-commission' AND (kind IS DISTINCT FROM 'report' OR status IS DISTINCT FROM 'report');

UPDATE law_provisions p SET status = 'report', in_force = NULL
FROM law_instruments i
WHERE p.act_id = i.id AND i.regulator = 'law-commission' AND p.status IS DISTINCT FROM 'report';

UPDATE law_instruments SET title =
  'Law Commission of India, Report No. ' || ltrim(substring(title FROM '^([0-9]+)'), '0')
  || coalesce(', Vol. ' || ltrim(substring(title FROM '(?i)Vol\s*([0-9]+)'), '0'), '')
  || CASE WHEN title ~* 'hindi' THEN ' (Hindi)' ELSE '' END
WHERE regulator = 'law-commission' AND title ~* '^[0-9]+\s+(accessible|click here)';

-- Some source titles and headings carry HTML entities from the publishers' pages ("&quot;Tribhuvan&quot;"). Decode the
-- common ones; the words are unchanged.
UPDATE law_instruments SET title = replace(replace(replace(replace(replace(title, '&quot;', '"'), '&amp;', '&'), '&#39;', ''''), '&lt;', '<'), '&gt;', '>')
WHERE title ~ '&(quot|amp|#39|lt|gt);';
UPDATE law_provisions SET heading = replace(replace(replace(replace(replace(heading, '&quot;', '"'), '&amp;', '&'), '&#39;', ''''), '&lt;', '<'), '&gt;', '>')
WHERE heading ~ '&(quot|amp|#39|lt|gt);';
