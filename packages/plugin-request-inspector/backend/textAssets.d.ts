// packPlugin embeds .py imports as text with esbuild's text loader.
declare module "*.py" {
  const text: string;
  export default text;
}
