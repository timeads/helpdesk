-- Sample tickets for trying the UI locally (npm run seed:demo). Never run against production.
INSERT OR IGNORE INTO agents (id, email, name, role) VALUES (1, 'kingtuft@tufttheworld.com', 'Tim', 'admin');
INSERT INTO tickets (id, gmail_thread_id, subject, customer_email, customer_name, status, assignee_id, unread, snippet, message_count, created_at, last_message_at, last_inbound_at) VALUES
 (1, 'demo-1', 'Where is my tufting gun order?', 'jane.doe@example.com', 'Jane Doe', 'open', NULL, 1, 'Hi! I ordered the AK-I tufting gun last week and haven''t received a tracking number yet…', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now','-50 minutes'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-50 minutes'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-50 minutes')),
 (2, 'demo-2', 'Wrong yarn color received', 'marcus@example.com', 'Marcus Lee', 'open', 1, 0, 'I ordered Mustard but got Goldenrod. Photo attached. Can I swap?', 2, strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 hours'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 hours')),
 (3, 'demo-3', 'Workshop gift card question', 'priya@example.com', 'Priya Patel', 'open', NULL, 1, 'Can a gift card be used for the Saturday rug workshop at the Bok Building?', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 hours'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 hours'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 hours')),
 (4, 'demo-4', 'Primary tufting cloth width', 'sam@example.com', 'Sam Rivera', 'in_progress', 1, 0, 'Thanks — the 2m width is what I needed.', 2, strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days'));
INSERT INTO messages (ticket_id, gmail_message_id, direction, from_email, from_name, to_emails, subject, sent_at, body_text, attachments) VALUES
 (1, 'demo-m1', 'in', 'jane.doe@example.com', 'Jane Doe', 'support@tufttheworld.com', 'Where is my tufting gun order?', strftime('%Y-%m-%dT%H:%M:%fZ','now','-50 minutes'),
  'Hi! I ordered the AK-I tufting gun last week (order #1042) and haven''t received a tracking number yet. Could you check on it? I''m hoping to start a project this weekend.

Thanks,
Jane

On Mon, Sep 28, 2026 at 9:14 AM Tuft the World <orders@tufttheworld.com> wrote:
> Thank you for your order!', '[]'),
 (2, 'demo-m2', 'in', 'marcus@example.com', 'Marcus Lee', 'support@tufttheworld.com', 'Wrong yarn color received', strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day'),
  'Hello, I ordered 4 cones of Mustard acrylic but received Goldenrod. Photo attached. Can I swap?', '[{"id":"x","filename":"yarn.jpg","mimeType":"image/jpeg","size":184320}]'),
 (2, 'demo-m3', 'out', 'support@tufttheworld.com', 'Tuft the World Support', 'marcus@example.com', 'Re: Wrong yarn color received', strftime('%Y-%m-%dT%H:%M:%fZ','now','-20 hours'),
  'So sorry about that, Marcus! We''ll send Mustard out today — no need to return the Goldenrod.', '[]'),
 (2, 'demo-m4', 'in', 'marcus@example.com', 'Marcus Lee', 'support@tufttheworld.com', 'Re: Wrong yarn color received', strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 hours'),
  'Amazing, thank you! Do you have a tracking number yet?', '[]'),
 (3, 'demo-m5', 'in', 'priya@example.com', 'Priya Patel', 'support@tufttheworld.com', 'Workshop gift card question', strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 hours'),
  'Can a gift card be used for the Saturday rug workshop at the Bok Building? Also is parking available nearby?', '[]'),
 (4, 'demo-m6', 'in', 'sam@example.com', 'Sam Rivera', 'support@tufttheworld.com', 'Primary tufting cloth width', strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days'),
  'What width does the primary tufting cloth come in?', '[]'),
 (4, 'demo-m7', 'out', 'support@tufttheworld.com', 'Tuft the World Support', 'sam@example.com', 'Re: Primary tufting cloth width', strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day'),
  'Hi Sam — it''s 2 meters wide, sold by the yard.', '[]');
INSERT INTO notes (ticket_id, agent_id, body) VALUES (2, 1, 'Replacement packed — ship Ground.');
INSERT INTO events (ticket_id, agent_id, kind, detail, created_at) VALUES (2, 1, 'assigned', 'Tim', strftime('%Y-%m-%dT%H:%M:%fZ','now','-21 hours'));
INSERT INTO macros (name, body) VALUES
 ('Order status — shipped', 'Hi {{first_name}},

Good news — your order is on its way! You can follow it here: [tracking link]

Thanks for tufting with us,
{{agent_name}}'),
 ('Workshop gift cards', 'Hi {{first_name}},

Yes! Gift cards can be used for any workshop — just enter the code at checkout when you book.');

-- Sample shipments for the analytics page (fake)
INSERT INTO shipments (order_id, order_name, service_code, service_name, shipment_id, tracking_numbers, labels, cost, currency, packages, ship_to, status, fulfilled, agent_id, created_at, shipping_paid, order_total, order_created_at, requested_service, list_cost, item_count, dest_state, dest_country) VALUES
 ('gid://shopify/Order/8001', '#0991', '03', 'UPS Ground', '1ZDEMO1', '["1ZDEMO1"]', '[]', 9.62, 'USD', '[]', '{"name":"A","state":"MI"}', 'purchased', 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now','-20 days'), 12.00, 120, strftime('%Y-%m-%dT%H:%M:%fZ','now','-21 days'), 'Standard', 12.34, 3, 'MI', 'US'),
 ('gid://shopify/Order/8002', '#0995', '03', 'UPS Ground', '1ZDEMO2', '["1ZDEMO2"]', '[]', 12.47, 'USD', '[]', '{"name":"B","state":"NY"}', 'purchased', 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now','-13 days'), 33.00, 416, strftime('%Y-%m-%dT%H:%M:%fZ','now','-14 days'), 'Standard Large', 15.10, 11, 'NY', 'US'),
 ('gid://shopify/Order/8003', '#1001', '02', 'UPS 2nd Day Air', '1ZDEMO3', '["1ZDEMO3"]', '[]', 20.28, 'USD', '[]', '{"name":"C","state":"CA"}', 'purchased', 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now','-6 days'), 18.00, 89, strftime('%Y-%m-%dT%H:%M:%fZ','now','-6 days','-5 hours'), 'Express', 24.90, 2, 'CA', 'US'),
 ('gid://shopify/Order/8004', '#1003', '03', 'UPS Ground', '1ZDEMO4', '["1ZDEMO4"]', '[]', 8.90, 'USD', '[]', '{"name":"D","state":"PA"}', 'purchased', 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days'), 9.50, 64, strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 days'), 'Standard', 10.20, 4, 'PA', 'US');

-- Support extras: tags, priority, threads, a snoozed ticket
UPDATE tickets SET tags = '["Repairs","VIP"]', priority = 'high' WHERE gmail_thread_id = 'demo-1';
UPDATE tickets SET tags = '["ORDER-STATUS"]' WHERE gmail_thread_id = 'demo-2';
UPDATE tickets SET status = 'snoozed', snoozed_until = strftime('%Y-%m-%dT%H:%M:%fZ','now','+2 days') WHERE gmail_thread_id = 'demo-3';
INSERT OR IGNORE INTO ticket_threads (thread_id, ticket_id, subject) SELECT gmail_thread_id, id, subject FROM tickets WHERE gmail_thread_id LIKE 'demo-%';
UPDATE messages SET thread_id = (SELECT gmail_thread_id FROM tickets WHERE tickets.id = messages.ticket_id) WHERE thread_id IS NULL;
