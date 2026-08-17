import { codeToHtml } from "rangi/core";
import { bash, js, js_template_literals, jsdoc, regex, todo, ts } from "rangi/languages";
import { cssVariables } from "rangi/themes";

const languages = {
  bash,
  js,
  js_template_literals,
  jsdoc,
  regex,
  sh: bash,
  todo,
  ts,
};

export const highlight = (code: string, lang: string) =>
  codeToHtml(code, {
    lang,
    languages,
    lineNumbers: false,
    theme: cssVariables,
  });
