// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { verifyInstallation, requiredGuards, transformNativeModule } from "./compatibility.ts";

const bunModule = "bun";
const { plugin, version } = await import(bunModule);
const root = NodeFS.realpathSync(process.argv[2]!);
verifyInstallation(root, version);
plugin({
  name: "t3-omp-native-policy",
  setup(build: {
    onLoad(options: { filter: RegExp }, callback: (args: { path: string }) => unknown): void;
  }) {
    build.onLoad(
      {
        filter: new RegExp(
          "^" +
            root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
            "/src/(?:" +
            requiredGuards.map((name) => name.replaceAll(".", "\\.")).join("|") +
            ")$",
        ),
      },
      ({ path }) => {
        const name = NodePath.relative(NodePath.join(root, "src"), path).replaceAll("\\", "/");
        if (!requiredGuards.includes(name)) return;
        if (NodeFS.realpathSync(path) !== NodePath.join(root, "src", name))
          throw new Error("OMP guard module path mismatch");
        return {
          loader: "ts",
          contents: transformNativeModule(
            name,
            NodeFS.readFileSync(path, "utf8"),
            new URL("./runtimePolicyHooks.ts", import.meta.url).href,
          ),
        };
      },
    );
  },
});
