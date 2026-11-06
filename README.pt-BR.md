# asaas-webhook-kit

Kit pequeno e sem dependências para tratar webhooks de pagamento do [Asaas](https://docs.asaas.com) com segurança: valida o envelope, normaliza eventos em fatos do provedor, mantém uma inbox durável e aplica os eventos de forma resistente a duplicidade, queda e entrega fora de ordem. As regras de acesso do seu produto continuam suas.

**Status: 0.1.0, não publicado (`private: true`), inicial.** Escrito a partir do comportamento observado de uma integração privada. Nenhum outro produto o consome ainda; a API não está provada.

Exige Node.js >= 22.13 (usa o `node:sqlite` embutido; sem dependências).

## O que faz

- Valida `id`, `event` e `payment.id` (para os eventos de pagamento que conhece). Os erros citam o campo, nunca o valor.
- Normaliza `PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED`, `PAYMENT_OVERDUE` e `PAYMENT_REFUNDED`. Qualquer outro evento é `unknown`: é registrado e a política nunca é consultada, então nunca concede nada.
- Separa fato do provedor de política. A política é uma função sua; o kit não traz padrão que conceda ou revogue acesso.
- Inbox durável em SQLite: `receive()` grava `pending` e diz qual status HTTP responder (200 só depois de gravar; falha ao gravar vira 503). `processDue()` aplica depois.
- Idempotência por id do evento + hash SHA-256 do payload. Mesmo id e mesmo payload: sem novo efeito. Mesmo id com conteúdo diferente: conflito registrado e entidade marcada para reconciliação.
- Ordem por pagamento pelo `dateCreated`. Evento mais antigo que o estado: sem efeito. Mesmo instante: não há ordem causal; a política decide e pode responder `reconciliation_required`.
- Inbox, estado e registro de efeito no mesmo commit. A política roda dentro dele: síncrona e sem efeitos colaterais.
- Erro da política mantém o evento pendente com retry; depois de `maxAttempts` vira `dead`.
- Evento tardio ou contraditório vira no-op ou marca a entidade; nunca concede nem revoga sozinho. Snapshot de reconciliação incompleto não muda nada.

## O que não faz

Não é servidor HTTP e não autentica: valide o token do Asaas **antes** de chamar `receive()`. Não faz chamadas de rede nem busca o estado no provedor (você passa o snapshot). Não trata assinaturas, checkouts nem eventos que não sejam de cobrança (são ignorados). Não tem integração com Next.js ou Prisma. Não está provado em produção.

## Uso rápido

```js
import { openInbox, createEntitlementPolicy } from "asaas-webhook-kit";

// DECISÃO SUA; este mapa é só um exemplo.
const policy = createEntitlementPolicy({
  onFact: { payment_confirmed: "grant", payment_refunded: "revoke" },
});
const inbox = openInbox({ path: "./webhooks.db", policy });

const r = inbox.receive(corpoBruto); // depois de autenticar
resposta.status(r.ack).end();

inbox.processDue();
for (const efeito of inbox.listEffects()) {
  await aplicar(efeito); // use efeito.effectKey como chave de idempotência
  inbox.markEffectApplied(efeito.effectKey);
}
```

CLI local: `node bin/asaas-webhook-kit.mjs demo`, `node bin/asaas-webhook-kit.mjs conformance` ou `node bin/asaas-webhook-kit.mjs validate evento.json`. Códigos de saída: `0` ok, `1` conformidade falhou, `2` uso incorreto ou entrada inválida. O demo usa política apenas de demonstração e não acessa a rede. O nome é provisório e não foi publicado; não use `npx` para buscá-lo no registro.

A reconciliação recusa observação anterior ao último fato aplicado ou posterior ao relógio configurado. Os identificadores armazenados também podem ser sensíveis: minimizar o payload não anonimiza os dados de cobrança.

Documentação do provedor (lida nas notas de pesquisa do projeto em 06/11/2026, sem nova consulta pelo pacote): [Webhooks](https://docs.asaas.com/docs/sobre-os-webhooks), [Tipos de envio](https://docs.asaas.com/docs/tipos-de-envio), [Fila pausada](https://docs.asaas.com/docs/fila-pausada).

Veja [SECURITY.md](SECURITY.md) e [PROVENANCE.md](PROVENANCE.md) (em inglês). Licença MIT, somente para o código deste pacote.
