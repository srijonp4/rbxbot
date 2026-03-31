import { file } from "bun";
import { parse, type TomlTable } from "smol-toml";

async function parseConfigFile(): Promise<TomlTable> {
  try {
    const configFile = file("config.toml");
    const fileContentAsString = await configFile.text();
    const parsedJSON = parse(fileContentAsString);
    return parsedJSON;
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error("failed to parse and load the config file");
  }
}

export default parseConfigFile;
