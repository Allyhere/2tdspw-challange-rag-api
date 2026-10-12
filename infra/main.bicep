@description('Região permitida na assinatura de estudante. Chile Central é a padrão.')
@allowed([
  'chilecentral'
  'eastus2'
  'southafricanorth'
  'canadacentral'
  'spaincentral'
])
param location string = 'chilecentral'

@description('Nome do Container App. Entra no FQDN padrão.')
@minLength(2)
@maxLength(32)
param appName string = 'veti-rag-api'

@description('Nome do ambiente de Container Apps.')
param environmentName string = 'veti-rag-env'

@description('Imagem no GHCR. O Container App sempre autentica o pull, mesmo com o pacote público.')
param containerImage string

@description('Host do registry.')
param registryServer string = 'ghcr.io'

@description('Usuário do GitHub, em minúsculas.')
param registryUsername string = 'allyhere'

@description('URI de conexão do Aura. neo4j+s:// é reescrito para bolt+s:// na API.')
param neo4jUri string

@description('Usuário do Aura.')
param neo4jUser string = 'neo4j'

@description('Modelo de chat. Vira NLP_MODEL.')
param chatModel string = 'gemini-3.5-flash-lite'

@description('Modelo de embedding. Vira EMBED_MODEL.')
param embedModel string = 'gemini-embedding-001'

@description('ID do projeto Firebase compartilhado pelos dois clientes.')
param firebaseProjectId string

@description('E-mail da service account usada pelo Firebase Admin.')
param firebaseClientEmail string

@description('Origens web permitidas, separadas por vírgula.')
param corsOrigins string

@description('0 pausa a API. 1 deixa uma réplica no ar no dia da demo.')
@minValue(0)
@maxValue(1)
param minReplicas int = 0

@secure()
@description('Chave da API Gemini. Passe na CLI; não grave no arquivo de parâmetros.')
param geminiApiKey string

@secure()
@description('Senha do Aura. Passe na CLI; não grave no arquivo de parâmetros.')
param neo4jPassword string

@secure()
@description('Personal access token clássico do GitHub com read:packages.')
param registryPassword string

@secure()
@description('Chave privada PEM da service account Firebase.')
param firebasePrivateKey string

@description('URL do webhook de chat da API Nest. Vazio desliga o aviso.')
param nestChatWebhookUrl string = ''

@secure()
@description('Segredo enviado em x-chat-webhook-secret. Vazio desliga o aviso.')
param nestChatWebhookSecret string

var notifyNest = !empty(nestChatWebhookUrl) && !empty(nestChatWebhookSecret)

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  properties: {
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
  }
}

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 3000
        transport: 'http'
        allowInsecure: false
      }
      registries: [
        {
          server: registryServer
          username: registryUsername
          passwordSecretRef: 'ghcr-pull'
        }
      ]
      secrets: concat([
        {
          name: 'gemini-api-key'
          value: geminiApiKey
        }
        {
          name: 'neo4j-password'
          value: neo4jPassword
        }
        {
          name: 'ghcr-pull'
          value: registryPassword
        }
        {
          name: 'firebase-private-key'
          value: firebasePrivateKey
        }
      ], notifyNest ? [
        {
          name: 'nest-chat-webhook-secret'
          value: nestChatWebhookSecret
        }
      ] : [])
    }
    template: {
      containers: [
        {
          name: 'api'
          image: containerImage
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: concat([
            {
              name: 'PORT'
              value: '3000'
            }
            {
              name: 'GEMINI_API_KEY'
              secretRef: 'gemini-api-key'
            }
            {
              name: 'NEO4J_PASSWORD'
              secretRef: 'neo4j-password'
            }
            {
              name: 'NEO4J_URI'
              value: neo4jUri
            }
            {
              name: 'NEO4J_USER'
              value: neo4jUser
            }
            {
              name: 'NLP_MODEL'
              value: chatModel
            }
            {
              name: 'EMBED_MODEL'
              value: embedModel
            }
            {
              name: 'FIREBASE_PROJECT_ID'
              value: firebaseProjectId
            }
            {
              name: 'FIREBASE_CLIENT_EMAIL'
              value: firebaseClientEmail
            }
            {
              name: 'FIREBASE_PRIVATE_KEY'
              secretRef: 'firebase-private-key'
            }
            {
              name: 'CORS_ORIGINS'
              value: corsOrigins
            }
            {
              name: 'GEMINI_TIMEOUT_MS'
              value: '20000'
            }
          ], notifyNest ? [
            {
              name: 'NEST_CHAT_WEBHOOK_URL'
              value: nestChatWebhookUrl
            }
            {
              name: 'NEST_CHAT_WEBHOOK_SECRET'
              secretRef: 'nest-chat-webhook-secret'
            }
          ] : [])
          probes: [
            {
              type: 'Readiness'
              httpGet: {
                path: '/health'
                port: 3000
                scheme: 'HTTP'
              }
              initialDelaySeconds: 5
              periodSeconds: 10
              timeoutSeconds: 5
              failureThreshold: 3
            }
            {
              type: 'Liveness'
              httpGet: {
                path: '/health'
                port: 3000
                scheme: 'HTTP'
              }
              initialDelaySeconds: 20
              periodSeconds: 30
              timeoutSeconds: 5
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: 1
        rules: [
          {
            name: 'http-concurrency'
            http: {
              metadata: {
                concurrentRequests: '10'
              }
            }
          }
        ]
      }
    }
  }
}

output fqdn string = app.properties.configuration.ingress.fqdn
output url string = 'https://${app.properties.configuration.ingress.fqdn}'
