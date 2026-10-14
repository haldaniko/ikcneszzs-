UPDATE generated_posts SET title='中文 тест', tags=ARRAY['中文','тест'] WHERE slug='test';
UPDATE admin_settings SET value='"多语言 prompt"' WHERE key='masterPrompt';
