# Automação de releases e publicação — DOMnodeshot

## Fluxo adotado

Recomendado para este projeto:

1. fazer mudanças no código;
2. atualizar `version` em `manifest.json`;
3. criar tag Git `vX.Y.Z`;
4. dar push da tag;
5. GitHub Actions:
   - valida se tag bate com `manifest.json`;
   - gera ZIP da extensão;
   - cria GitHub Release com notas automáticas;
   - publica na Chrome Web Store se secrets estiverem configurados.

---

## Workflows criados

Arquivos:

- `.github/workflows/release.yml`
- `.github/workflows/bump-version.yml`

Triggers:

- `push` em tags `v*`
- `workflow_dispatch` para bump manual de versão (`patch` / `minor` / `major`)

---

## Secrets necessários para publicar na Chrome Web Store

Adicionar em **GitHub → Settings → Secrets and variables → Actions**:

- `CHROME_EXTENSION_ID`
- `CHROME_CLIENT_ID`
- `CHROME_CLIENT_SECRET`
- `CHROME_REFRESH_TOKEN`

Sem esses secrets:
- release no GitHub continua funcionando;
- publicação na Chrome Web Store é pulada.

---

## Como obter credenciais Google / Chrome Web Store API

Resumo recomendado:

- `CHROME_EXTENSION_ID`: vem do painel da extensão
- `CHROME_CLIENT_ID` e `CHROME_CLIENT_SECRET`: vêm de OAuth Client no Google Cloud
- `CHROME_REFRESH_TOKEN`: vem de fluxo OAuth autorizado pela conta dona da extensão

## 1) Descobrir `CHROME_EXTENSION_ID`

No painel da extensão publicada na Chrome Web Store, copie ID da extensão.

Formato típico:

- `abcdefghijklmnopqrstuvwxyzabcdef`

---

## 2) Criar projeto no Google Cloud

1. abrir Google Cloud Console;
2. criar projeto novo ou usar existente;
3. ativar Chrome Web Store API para projeto.

---

## 3) Configurar OAuth consent screen

1. abrir **APIs & Services → OAuth consent screen**;
2. configurar app;
3. adicionar seu usuário como test user, se necessário.

---

## 4) Criar OAuth Client ID

1. abrir **APIs & Services → Credentials**;
2. clicar **Create Credentials → OAuth client ID**;
3. tipo recomendado: **Desktop app**.

Salvar:

- `CLIENT_ID`
- `CLIENT_SECRET`

Eles viram:

- `CHROME_CLIENT_ID`
- `CHROME_CLIENT_SECRET`

---

## 5) Gerar refresh token

Forma simples: usar OAuth 2.0 Playground.

Escopo para publicação:

- `https://www.googleapis.com/auth/chromewebstore`

### Passo a passo pelo OAuth 2.0 Playground

1. abrir https://developers.google.com/oauthplayground;
2. clicar no ícone de engrenagem no canto superior direito;
3. marcar **Use your own OAuth credentials**;
4. preencher:
   - **OAuth Client ID**: valor de `CHROME_CLIENT_ID`;
   - **OAuth Client secret**: valor de `CHROME_CLIENT_SECRET`;
5. no campo/lista de scopes, adicionar manualmente:

```text
https://www.googleapis.com/auth/chromewebstore
```

6. clicar **Authorize APIs**;
7. fazer login com a mesma conta que possui permissão para publicar a extensão na Chrome Web Store;
8. clicar **Exchange authorization code for tokens**;
9. copiar o valor de **Refresh token**;
10. atualizar o secret no GitHub:
    - repositório → **Settings**;
    - **Secrets and variables** → **Actions**;
    - editar/criar `CHROME_REFRESH_TOKEN`;
11. reexecutar o workflow de release/publicação.

### Se o refresh token não aparecer

1. confirmar que **Use your own OAuth credentials** está marcado;
2. confirmar que o OAuth Client é do tipo **Desktop app**;
3. confirmar que a conta logada é dona/publicadora da extensão;
4. confirmar escopo exato:

```text
https://www.googleapis.com/auth/chromewebstore
```

5. revogar acesso antigo em https://myaccount.google.com/permissions e gerar token novamente.

### Diagnóstico do erro `Failed to obtain OAuth access token`

Esse erro acontece antes do upload para a Chrome Web Store, na troca:

```text
refresh_token → access_token
```

Causas comuns:

- `CHROME_REFRESH_TOKEN` expirado, revogado ou gerado para outro client;
- `CHROME_CLIENT_ID` / `CHROME_CLIENT_SECRET` não correspondem ao refresh token;
- conta usada no OAuth não tem permissão para publicar a extensão;
- OAuth consent/app em modo teste com autorização inválida.

Correção mais comum: gerar novo refresh token pelo OAuth Playground e substituir `CHROME_REFRESH_TOKEN` no GitHub Actions.

---

## Uso diário

### Opção 1: bump manual pela interface do GitHub

1. abrir **Actions**;
2. rodar workflow **Bump Version**;
3. escolher `patch`, `minor` ou `major`.

Resultado:
- `manifest.json` atualizado;
- commit automático;
- tag `vX.Y.Z` criada;
- workflow de release dispara sozinho.

### Opção 2: release sem publicar store

Se secrets ainda não existirem:

```bash
jq '.version = "1.0.2"' manifest.json > /tmp/manifest.json && mv /tmp/manifest.json manifest.json
git add manifest.json
git commit -m "Bump version to 1.0.2"
git tag v1.0.2
git push origin main --tags
```

Resultado:
- ZIP gerado;
- GitHub Release criado;
- notas automáticas geradas;
- publish CWS pulado.

### Opção 3: release + publish automático

Depois de configurar secrets:

```bash
git tag v1.0.2
git push origin v1.0.2
```

Resultado:
- ZIP gerado;
- GitHub Release criado;
- upload CWS;
- publish `default`.

---

## Como escrever notas melhores de release

GitHub gera notas automáticas melhor quando commits/PRs são claros.

Recomendado usar mensagens tipo:

- `fix: corrige captura com Enter`
- `feat: adiciona Cmd+Enter no macOS`
- `docs: documenta fluxo de release`

---

## Limitações / observações

- publicação automática não substitui revisão manual da Chrome Web Store quando exigida;
- algumas versões podem entrar em revisão antes de ficar públicas;
- se API retornar erro, release no GitHub continua criado, mas publish falha;
- se tag não bater com `manifest.json`, workflow falha de propósito.
