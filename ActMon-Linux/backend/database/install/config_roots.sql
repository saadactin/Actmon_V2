--
-- PostgreSQL database dump
--

\restrict rDeLntTNKasjvHMMkvPNYaVTkiOdja7B8GEug3cfb8q5SIEASMI7vX0CWIrbbvL

-- Dumped from database version 17.9
-- Dumped by pg_dump version 17.9

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Data for Name: permission; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.permission (permission_id, permission_value, permission_name, is_active, created_by, created_at, modified_by, modified_at, deleted_by, deleted_at, org_id) OVERRIDING SYSTEM VALUE VALUES (1, 1, 'View', true, 1, '2026-06-22 13:20:52.221987', NULL, NULL, NULL, NULL, 1);
INSERT INTO public.permission (permission_id, permission_value, permission_name, is_active, created_by, created_at, modified_by, modified_at, deleted_by, deleted_at, org_id) OVERRIDING SYSTEM VALUE VALUES (2, 2, 'Add', true, 1, '2026-06-22 13:20:52.221987', NULL, NULL, NULL, NULL, 1);
INSERT INTO public.permission (permission_id, permission_value, permission_name, is_active, created_by, created_at, modified_by, modified_at, deleted_by, deleted_at, org_id) OVERRIDING SYSTEM VALUE VALUES (3, 4, 'Edit', true, 1, '2026-06-22 13:20:52.221987', NULL, NULL, NULL, NULL, 1);
INSERT INTO public.permission (permission_id, permission_value, permission_name, is_active, created_by, created_at, modified_by, modified_at, deleted_by, deleted_at, org_id) OVERRIDING SYSTEM VALUE VALUES (4, 8, 'Delete', true, 1, '2026-06-22 13:20:52.221987', NULL, NULL, NULL, NULL, 1);
INSERT INTO public.permission (permission_id, permission_value, permission_name, is_active, created_by, created_at, modified_by, modified_at, deleted_by, deleted_at, org_id) OVERRIDING SYSTEM VALUE VALUES (5, 16, 'Import', true, 1, '2026-06-22 13:20:52.221987', NULL, NULL, NULL, NULL, 1);
INSERT INTO public.permission (permission_id, permission_value, permission_name, is_active, created_by, created_at, modified_by, modified_at, deleted_by, deleted_at, org_id) OVERRIDING SYSTEM VALUE VALUES (6, 32, 'Export', true, 1, '2026-06-22 13:20:52.221987', NULL, NULL, NULL, NULL, 1);
INSERT INTO public.permission (permission_id, permission_value, permission_name, is_active, created_by, created_at, modified_by, modified_at, deleted_by, deleted_at, org_id) OVERRIDING SYSTEM VALUE VALUES (8, 128, 'Approve', true, 1, '2026-06-22 13:20:52.221987', NULL, NULL, NULL, NULL, 1);
INSERT INTO public.permission (permission_id, permission_value, permission_name, is_active, created_by, created_at, modified_by, modified_at, deleted_by, deleted_at, org_id) OVERRIDING SYSTEM VALUE VALUES (9, 255, 'Full Access', true, 1, '2026-06-22 13:20:52.221987', NULL, NULL, NULL, NULL, 1);
INSERT INTO public.permission (permission_id, permission_value, permission_name, is_active, created_by, created_at, modified_by, modified_at, deleted_by, deleted_at, org_id) OVERRIDING SYSTEM VALUE VALUES (10, 510, 'test api', true, 1, '2026-06-22 16:06:54.687557', NULL, NULL, NULL, NULL, 1);
INSERT INTO public.permission (permission_id, permission_value, permission_name, is_active, created_by, created_at, modified_by, modified_at, deleted_by, deleted_at, org_id) OVERRIDING SYSTEM VALUE VALUES (7, 64, 'Execute', true, 1, '2026-06-22 13:20:52.221987', NULL, NULL, 1, '2026-06-22 16:07:20.80906', 1);


--
-- Data for Name: status_master; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.status_master (status_id, status_code, status_name, status_description, is_active, created_by, created_at, modified_by, modified_at, deleted_by, deleted_at, org_id) OVERRIDING SYSTEM VALUE VALUES (1, 'ACTIVE', 'Active', 'Active Record', true, 1, '2026-06-22 11:31:14.306187', NULL, NULL, NULL, NULL, 1);
INSERT INTO public.status_master (status_id, status_code, status_name, status_description, is_active, created_by, created_at, modified_by, modified_at, deleted_by, deleted_at, org_id) OVERRIDING SYSTEM VALUE VALUES (2, 'INACTIVE', 'Inactive', 'Inactive Record', true, 1, '2026-06-22 11:31:14.306187', NULL, NULL, NULL, NULL, 1);
INSERT INTO public.status_master (status_id, status_code, status_name, status_description, is_active, created_by, created_at, modified_by, modified_at, deleted_by, deleted_at, org_id) OVERRIDING SYSTEM VALUE VALUES (3, 'DELETED', 'Deleted', 'Deleted Record', true, 1, '2026-06-22 11:31:14.306187', NULL, NULL, NULL, NULL, 1);
INSERT INTO public.status_master (status_id, status_code, status_name, status_description, is_active, created_by, created_at, modified_by, modified_at, deleted_by, deleted_at, org_id) OVERRIDING SYSTEM VALUE VALUES (4, 'SUSPENDED', 'Suspended', 'Suspended Record', true, 1, '2026-06-22 11:31:14.306187', NULL, NULL, NULL, NULL, 1);


--
-- Name: permission_permission_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.permission_permission_id_seq', 10, true);


--
-- Name: status_master_status_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.status_master_status_id_seq', 4, true);


--
-- PostgreSQL database dump complete
--

\unrestrict rDeLntTNKasjvHMMkvPNYaVTkiOdja7B8GEug3cfb8q5SIEASMI7vX0CWIrbbvL

