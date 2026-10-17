-- Spread seeded Akkoma posts over ~60 days (newest = now), keeping id order. Run once after akkoma_seed.py.
with o as (select id, row_number() over (order by id desc) rn from objects)
update objects set inserted_at = now() - o.rn * interval '27 minutes',
  data = jsonb_set(data, '{published}', to_jsonb(to_char((now() - o.rn * interval '27 minutes') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
from o where objects.id = o.id;
update activities a set inserted_at = o.inserted_at, data = jsonb_set(a.data, '{published}', o.data->'published')
from objects o where a.data->>'type' = 'Create' and a.data->>'object' = o.data->>'id';
update activities a set inserted_at = o.inserted_at + interval '41 minutes',
  data = jsonb_set(a.data, '{published}', to_jsonb(to_char((o.inserted_at + interval '41 minutes') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
from objects o where a.data->>'type' in ('Like', 'Announce') and a.data->>'object' = o.data->>'id';
update users set inserted_at = now() - (300 + abs(hashtext(nickname)) % 400) * interval '1 day' where local;
