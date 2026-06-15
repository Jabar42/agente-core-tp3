// Type declarations for non-TS imports handled by esbuild
declare module "*.md" {
  const content: string;
  export default content;
}
