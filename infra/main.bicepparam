using 'main.bicep'

param location = 'chilecentral'
param appName = 'veti-rag-api'
param environmentName = 'veti-rag-env'
// Troque pela imagem publicada no GHCR ou no Docker Hub.
param containerImage = 'ghcr.io/allyhere/veti-rag-api:auth-20261012-213031'
param registryServer = 'ghcr.io'
param registryUsername = 'allyhere'
param neo4jUri = readEnvironmentVariable('NEO4J_URI', 'neo4j+s://xxxxxxxx.databases.neo4j.io')
param neo4jUser = readEnvironmentVariable('NEO4J_USER', 'neo4j')
param chatModel = 'gemini-3.5-flash-lite'
param embedModel = 'gemini-embedding-001'
param minReplicas = 0
param firebaseProjectId = readEnvironmentVariable('FIREBASE_PROJECT_ID', '')
param firebaseClientEmail = readEnvironmentVariable('FIREBASE_CLIENT_EMAIL', '')
param firebasePrivateKey = readEnvironmentVariable('FIREBASE_PRIVATE_KEY', '')
param corsOrigins = readEnvironmentVariable('CORS_ORIGINS', 'http://localhost:5173')
// Lidos do ambiente na hora do deploy. Carregue o .env antes; não grave os valores aqui.
param geminiApiKey = readEnvironmentVariable('GEMINI_API_KEY', '')
param neo4jPassword = readEnvironmentVariable('NEO4J_PASSWORD', '')
param registryPassword = readEnvironmentVariable('GHCR_TOKEN', '')
param nestChatWebhookUrl = readEnvironmentVariable('NEST_CHAT_WEBHOOK_URL', '')
param nestChatWebhookSecret = readEnvironmentVariable('NEST_CHAT_WEBHOOK_SECRET', '')
