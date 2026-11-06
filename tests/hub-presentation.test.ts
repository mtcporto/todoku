import assert from "node:assert/strict";
import { test } from "node:test";
import { brandingSchema } from "../src/lib/hub/presentation.ts";
import { minhaNotaWelcome, renderManagedTemplate, validateTemplate } from "../src/lib/hub/templates.ts";

test("MinhaNota recovers the original welcome presentation without changing the firstName contract", () => {
  const result = renderManagedTemplate(minhaNotaWelcome, { firstName: "Pessoa <teste>" }, 2, brandingSchema.parse({ name: "MinhaNota" }));
  assert.equal(result.templateVersion, "minhanota.welcome@2");
  for (const fragment of ["Bem-vindo ao MinhaNota!", "acompanhar suas notas fiscais de serviço", "Acessar MinhaNota", "https://minhanota.app", "Se você não reconhece este acesso"]) {
    assert.ok(result.html.includes(fragment));
    assert.ok(result.text.includes(fragment));
  }
  assert.ok(result.html.includes("#163b73"));
  assert.ok(result.html.includes("max-width:560px"));
  assert.ok(result.html.includes('name="viewport"'));
  assert.ok(result.html.includes("Pessoa &lt;teste&gt;"));
  assert.ok(!result.html.includes("Pessoa <teste>"));
  assert.ok(!result.html.includes("{{"));
});

test("presentation and branding reject unsafe links and support only declared typed button variables", () => {
  for (const url of ["javascript:alert(1)", "http://example.invalid", "https://user:pass@example.invalid", "https://example.invalid/\nnext"]) {
    assert.equal(brandingSchema.safeParse({ name: "App", logoUrl: url }).success, false);
    assert.throws(() => validateTemplate({ ...minhaNotaWelcome, presentation: { ...minhaNotaWelcome.presentation, buttonUrl: url } }));
  }
  assert.throws(() => validateTemplate({ ...minhaNotaWelcome, presentation: { heading: "{{undeclared}}" } }));
  assert.throws(() => validateTemplate({ ...minhaNotaWelcome, presentation: { heading: "Título", buttonLabel: "Botão" } }));
  assert.throws(() => validateTemplate({ ...minhaNotaWelcome, presentation: { ...minhaNotaWelcome.presentation, buttonUrl: "https://example.invalid/{{firstName}}" } }));
  assert.equal(brandingSchema.safeParse({ name: "App", primaryColor: "red;background:url(x)" }).success, false);
  const template = validateTemplate({ ...minhaNotaWelcome, variables: [...minhaNotaWelcome.variables, { name: "url", type: "https_url" }], presentation: { ...minhaNotaWelcome.presentation, buttonUrl: "{{url}}" } });
  const rendered = renderManagedTemplate(template, { firstName: "Pessoa", url: "https://example.invalid/?a=1&b=2" }, 1);
  assert.ok(rendered.html.includes('href="https://example.invalid/?a=1&amp;b=2"'));
  assert.throws(() => renderManagedTemplate(template, { firstName: "Pessoa", url: "javascript:alert(1)" }, 1));
});
