/**
 * Convert a protobuf fully-qualified name to a Solidity-safe identifier.
 * e.g. "my_package.MyMessage" → "MyMessage"
 */
export function protoNameToSol(fqn: string): string {
  const parts = fqn.split(".")
  return parts[parts.length - 1]
}

/**
 * Convert snake_case field name to camelCase for Solidity struct members.
 * e.g. "user_name" → "userName"
 */
export function snakeToCamel(name: string): string {
  return name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
}

/**
 * Generate the Solidity library name for a message's codec.
 * e.g. "MyMessage" → "MyMessageCodec"
 */
export function codecLibName(messageName: string): string {
  return `${messageName}Codec`
}

/**
 * Generate output .sol filename for a given .proto file, optionally rooted
 * under a directory derived from the proto package name.
 * e.g. "my_service.proto" with package "example.nested"
 *      → "example/nested/MyService.pb.sol"
 */
export function protoFileToSolFile(protoFile: string, packageName?: string): string {
  const base = protoFile.replace(/\.proto$/, "")
  const parts = base.split("/")
  const filename = parts[parts.length - 1]
  const pascal = filename
    .split(/[_\-.]/)
    .map(s => s.charAt(0).toUpperCase() + s.slice(1))
    .join("")
  const solBasename = `${pascal}.pb.sol`
  if (!packageName) return solBasename
  const dir = packageName.split(".").join("/")
  return `${dir}/${solBasename}`
}

/**
 * Solidity pragma version range.
 */
export const SOL_PRAGMA = ">=0.8.0 <0.9.0"

/**
 * SPDX license identifier for generated files.
 */
export const SPDX_LICENSE = "MIT"
