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

## Workflow criado

Arquivo:

- `.github/workflows/release.yml`

Trigger:

- `push` em tags `v*`

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

Forma simples: usar OAuth Playground ou script local.

Escopo comum para publicação:

- `https://www.googleapis.com/auth/chromewebstore`

Fluxo geral:

1. autorizar conta dona da extensão;
2. trocar authorization code por access/refresh token;
3. guardar refresh token em secret `CHROME_REFRESH_TOKEN`.

---

## Uso diário

### Release sem publicar store

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

### Release + publish automático

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
