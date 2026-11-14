// KaTeX, loaded the first time an article has math: most have none, and it is 300 kB.
let loading = null;

// renderMath for renderWikitext: renders TeX to HTML. Waits for KaTeX only when text has a <math> tag.
export async function loadMath(text) {
  if (/<math[^>]*>/.test(text)) {
    loading ??= new Promise((resolve, reject) => {
      const css = Object.assign(document.createElement("link"), { rel: "stylesheet", href: new URL("./vendor/katex-0.16.11/katex.min.css", import.meta.url) });
      const script = Object.assign(document.createElement("script"), { src: new URL("./vendor/katex-0.16.11/katex.min.js", import.meta.url) });
      script.onload = () => resolve(window.katex);
      script.onerror = () => reject(new Error("KaTeX did not load"));
      document.head.append(css, script);
    });
    const katex = await loading;
    return (tex, displayMode) => katex.renderToString(tex, { displayMode, throwOnError: false });
  }
  return () => "";
}
