-- Migration : ajout de l'expiration des accès clients
-- Table ciblée : clients
-- Date : 2026-03-05
-- À exécuter dans l'éditeur SQL Supabase AVANT de déployer la version server.js
-- correspondante (qui vérifiera expires_at dans requireClientAuth et overlay:join).
--
-- EFFET : un client dont expires_at est dans le passé sera rejeté avec HTTP 403
-- au niveau du middleware requireClientAuth et de l'event overlay:join.
-- Un client avec expires_at IS NULL conserve un accès permanent (rétrocompatibilité).

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ DEFAULT NULL;

COMMENT ON COLUMN clients.expires_at IS
  'Date d''expiration de l''accès client. NULL = accès permanent. '
  'Quand cette date est dépassée, le serveur renvoie 403 même si active = true.';
