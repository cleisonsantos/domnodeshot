# Justificativa de permissões — Chrome Web Store

## debugger
Uso: capturar screenshot de elemento em tamanho completo, inclusive conteúdo fora da área visível da aba.

Motivo técnico: APIs comuns de captura (`captureVisibleTab`) limitam captura ao viewport. Recurso principal da extensão exige captura completa do elemento.

## downloads
Uso: salvar arquivo PNG resultante da captura do elemento.

Motivo técnico: produto promete download direto da imagem após clique no elemento.

## clipboardWrite
Uso: copiar imagem capturada para clipboard por padrão; copiar outerHTML quando usuário segura Ctrl/Shift.

Motivo técnico: fluxo principal inclui ação de copiar resultado sem passos extras.

## scripting / activeTab / tabs
Uso: injetar content script e CSS na aba ativa durante modo de seleção, controlar estado por aba e enviar mensagens.

Motivo técnico: highlight, overlay, interceptação de clique e coordenação com service worker dependem dessas permissões.

---

## Declaração de dados
- não coleta dados pessoais;
- não envia conteúdo de páginas para servidor externo;
- processamento local no navegador.
