# Regra Crítica — Isolamento do Stream POST /messages

Esta regra se aplica sempre que você modificar `src/index.ts` ou qualquer arquivo que configure o Express ou o transporte SSE do MCP.

---

## A Regra

**Nunca modifique a rota `POST /messages` de forma que o body stream seja lido antes de chegar ao `SSEServerTransport.handlePostMessage`.**

---

## Por que isso importa

O SDK MCP (`SSEServerTransport.handlePostMessage`) usa `getRawBody()` internamente para ler o corpo da requisição. Se qualquer middleware Express já tiver consumido esse stream antes — como `express.json()`, `express.urlencoded()`, `express.raw()` ou qualquer parser de terceiros — o SDK lança:

```
InternalServerError: stream is not readable
```

Isso quebra silenciosamente toda a comunicação entre o Claude e o servidor MCP.

---

## O Padrão Correto

Este projeto usa `app.use(express.json())` **globalmente**. Isso é intencional para outras rotas futuras. Para proteger o `/messages`, o body já parseado é repassado como terceiro argumento:

```typescript
// src/index.ts — CORRETO
app.post("/messages", async (req, res) => {
  if (!currentTransport) {
    res.status(400).json({ error: "No active SSE connection" });
    return;
  }
  // req.body foi parseado pelo express.json() global.
  // Repassamos como parsedBody para o SDK não tentar ler o stream novamente.
  await currentTransport.handlePostMessage(
    req as unknown as IncomingMessage,
    res as unknown as ServerResponse,
    req.body  // ← NUNCA REMOVER ESTE ARGUMENTO enquanto express.json() for global
  );
});
```

---

## O que NÃO fazer

```typescript
// ERRADO — causa "stream is not readable" se express.json() estiver ativo
await currentTransport.handlePostMessage(req, res);

// ERRADO — adicionar parser específico na rota /messages
app.post("/messages", express.json(), async (req, res) => { ... });

// ERRADO — adicionar qualquer middleware que leia o body antes de /messages
app.use("/messages", express.raw());
```

---

## Se você remover o `express.json()` global

Remova também o `req.body` do terceiro argumento. O SDK lerá o raw stream diretamente, o que é igualmente correto:

```typescript
// Sem express.json() global — também correto
await currentTransport.handlePostMessage(req, res); // sem parsedBody
```

---

## Checklist antes de qualquer PR que toque no Express

- [ ] `express.json()` global ainda presente? → `req.body` deve ser terceiro arg de `handlePostMessage`
- [ ] `express.json()` removido? → terceiro arg deve ser removido também
- [ ] Nenhum middleware novo lendo body em `/messages`?
- [ ] `npm run build` passou sem erros?
- [ ] `curl -N http://localhost:8080/sse` conecta normalmente?
