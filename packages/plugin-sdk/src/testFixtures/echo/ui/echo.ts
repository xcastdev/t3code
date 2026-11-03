import { connectT3, T3PluginError } from "@t3tools/plugin-sdk/ui";

void connectT3().then((client) => {
  const output = document.getElementById("output");
  document.getElementById("ping")?.addEventListener("click", async () => {
    try {
      const result = await client.call("ping", { message: "hello" });
      if (output !== null) output.textContent = JSON.stringify(result);
    } catch (error) {
      if (output !== null) {
        output.textContent =
          error instanceof T3PluginError ? (error.reason ?? error.message) : String(error);
      }
    }
  });
});
