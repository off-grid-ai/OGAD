-- Spread seeded HumHub content over ~60 days (newest = now), keeping id order. Run once after the seed.
UPDATE content c JOIN (SELECT id, ROW_NUMBER() OVER (ORDER BY id DESC) rn FROM content) x ON x.id = c.id
  SET c.created_at = NOW() - INTERVAL (x.rn * 75) MINUTE, c.updated_at = NOW() - INTERVAL (x.rn * 75) MINUTE, c.stream_sort_date = NOW() - INTERVAL (x.rn * 75) MINUTE;
UPDATE post p JOIN content c ON c.object_model = 'humhub\\modules\\post\\models\\Post' AND c.object_id = p.id
  SET p.created_at = c.created_at, p.updated_at = c.created_at;
UPDATE comment m JOIN content c ON c.object_model = m.object_model AND c.object_id = m.object_id
  SET m.created_at = c.created_at + INTERVAL (m.id % 97 + 3) MINUTE, m.updated_at = c.created_at + INTERVAL (m.id % 97 + 3) MINUTE;
UPDATE `like` l JOIN content c ON c.object_model = l.object_model AND c.object_id = l.object_id
  SET l.created_at = c.created_at + INTERVAL (l.id % 300 + 5) MINUTE;
UPDATE user SET created_at = NOW() - INTERVAL (300 + id * 9) DAY WHERE username <> 'farmadmin';
UPDATE space SET created_at = NOW() - INTERVAL (200 + id * 11) DAY;
