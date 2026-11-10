// Text assets that packPlugin embeds in the backend bundle with esbuild's text loader.
declare module "*.txt" {
  const text: string;
  export default text;
}
declare module "*.py" {
  const text: string;
  export default text;
}
