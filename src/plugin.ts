import * as protobuf from "protobufjs"
import { log, setLogLevel } from "./util/logger.js"
import { protoFileToSolFile } from "./util/names.js"
import { generateSolFile, generateRuntime } from "./generator/index.js"
import type { MessageDescriptor, FieldInfo } from "./generator/index.js"

// ── Protobuf schema for the plugin protocol ───────────────────────────
// Defined programmatically so the plugin is fully self-contained
// (no .proto files needed at runtime).

const pluginRoot = new protobuf.Root()

// google.protobuf.compiler.CodeGeneratorRequest (simplified)
const CodeGeneratorRequest = new protobuf.Type("CodeGeneratorRequest")
  .add(new protobuf.Field("file_to_generate", 1, "string", "repeated"))
  .add(new protobuf.Field("parameter", 2, "string", "optional"))
  .add(
    new protobuf.Field("proto_file", 15, "google.protobuf.FileDescriptorProto", "repeated")
  )

// google.protobuf.compiler.CodeGeneratorResponse
const ResponseFile = new protobuf.Type("File")
  .add(new protobuf.Field("name", 1, "string", "optional"))
  .add(new protobuf.Field("insertion_point", 2, "string", "optional"))
  .add(new protobuf.Field("content", 15, "string", "optional"))

const CodeGeneratorResponse = new protobuf.Type("CodeGeneratorResponse")
  .add(new protobuf.Field("error", 1, "string", "optional"))
  .add(new protobuf.Field("supported_features", 2, "uint64", "optional"))
  .add(new protobuf.Field("file", 15, "File", "repeated"))
  .add(ResponseFile)

// FileDescriptorProto and its nested types
const FieldDescriptorProto = new protobuf.Type("FieldDescriptorProto")
  .add(new protobuf.Field("name", 1, "string", "optional"))
  .add(new protobuf.Field("number", 3, "int32", "optional"))
  .add(new protobuf.Field("label", 4, "int32", "optional"))
  .add(new protobuf.Field("type", 5, "int32", "optional"))
  .add(new protobuf.Field("type_name", 6, "string", "optional"))
  .add(new protobuf.Field("default_value", 7, "string", "optional"))
  .add(new protobuf.Field("oneof_index", 9, "int32", "optional"))
  .add(new protobuf.Field("json_name", 10, "string", "optional"))

const MessageOptions = new protobuf.Type("MessageOptions")
  .add(new protobuf.Field("map_entry", 7, "bool", "optional"))

const DescriptorProto = new protobuf.Type("DescriptorProto")
  .add(new protobuf.Field("name", 1, "string", "optional"))
  .add(new protobuf.Field("field", 2, "FieldDescriptorProto", "repeated"))
  .add(new protobuf.Field("nested_type", 3, "DescriptorProto", "repeated"))
  .add(new protobuf.Field("options", 7, "MessageOptions", "optional"))
  .add(FieldDescriptorProto)
  .add(MessageOptions)

const FileDescriptorProto = new protobuf.Type("FileDescriptorProto")
  .add(new protobuf.Field("name", 1, "string", "optional"))
  .add(new protobuf.Field("package", 2, "string", "optional"))
  .add(new protobuf.Field("dependency", 3, "string", "repeated"))
  .add(new protobuf.Field("message_type", 4, "DescriptorProto", "repeated"))
  .add(new protobuf.Field("syntax", 12, "string", "optional"))
  .add(DescriptorProto)

// Wire types into namespaces
const googlePb = new protobuf.Namespace("google")
const protobufNs = new protobuf.Namespace("protobuf")
const compilerNs = new protobuf.Namespace("compiler")

protobufNs.add(FileDescriptorProto)
compilerNs.add(CodeGeneratorRequest)
compilerNs.add(CodeGeneratorResponse)
protobufNs.add(compilerNs)
googlePb.add(protobufNs)
pluginRoot.add(googlePb)

// Resolve all type references
pluginRoot.resolveAll()

// ── Plugin entry ──────────────────────────────────────────────────────

export interface PluginResult {
  files: Array<{ name: string; content: string }>
  error?: string
}

/**
 * Run the protoc plugin: decode request → generate Solidity → encode response.
 */
export function runPlugin(stdin: Buffer): Buffer {
  let result: PluginResult

  try {
    result = processRequest(stdin)
  } catch (err: any) {
    log.error("Plugin error: %s", err.message)
    result = { files: [], error: err.message }
  }

  return encodeResponse(result)
}

/**
 * Decode CodeGeneratorRequest, walk descriptors, produce output files.
 */
function processRequest(stdin: Buffer): PluginResult {
  const ReqType = pluginRoot.lookupType(
    "google.protobuf.compiler.CodeGeneratorRequest"
  )
  const request = ReqType.decode(stdin) as any

  // Parse plugin parameters (e.g. "log_level=debug")
  const params = parseParams(request.parameter ?? "")
  if (params.log_level) {
    setLogLevel(params.log_level)
  }

  const filesToGenerate = new Set<string>(request.file_to_generate ?? [])
  const protoFiles: any[] = request.proto_file ?? []

  log.info(
    "Processing %d proto file(s), generating for %d",
    protoFiles.length,
    filesToGenerate.size
  )

  const files: Array<{ name: string; content: string }> = []

  // Always emit the runtime library
  files.push({
    name: "ProtobufRuntime.sol",
    content: generateRuntime()
  })

  // Process each requested proto file
  for (const protoFile of protoFiles) {
    const fileName: string = protoFile.name ?? ""
    if (!filesToGenerate.has(fileName)) continue

    log.info("Generating for %s", fileName)

    const messages = extractMessages(protoFile, protoFile.package ?? "")
    if (messages.length === 0) {
      log.info("No messages in %s, skipping", fileName)
      continue
    }

    const solFileName = protoFileToSolFile(fileName, protoFile.package ?? "")
    const solContent = generateSolFile(messages, fileName)

    files.push({ name: solFileName, content: solContent })
    log.info("Generated %s (%d messages)", solFileName, messages.length)
  }

  return { files }
}

/**
 * Walk DescriptorProto tree, building our MessageDescriptor model.
 */
function extractMessages(
  protoFile: any,
  packageName: string
): MessageDescriptor[] {
  const result: MessageDescriptor[] = []
  const messageTypes: any[] = protoFile.message_type ?? []

  for (const msg of messageTypes) {
    result.push(convertDescriptor(msg, packageName))
  }

  return result
}

function convertDescriptor(desc: any, parentFqn: string): MessageDescriptor {
  const name: string = desc.name ?? ""
  const fullName = parentFqn ? `${parentFqn}.${name}` : name
  const isMapEntry: boolean = desc.options?.map_entry === true

  const fields: FieldInfo[] = (desc.field ?? []).map((f: any) => ({
    name: f.name ?? "",
    number: f.number ?? 0,
    type: f.type ?? 0,
    typeName: f.type_name,
    label: f.label ?? 1,
    oneofIndex: f.oneof_index
  }))

  const nestedMessages: MessageDescriptor[] = (desc.nested_type ?? []).map(
    (nested: any) => convertDescriptor(nested, fullName)
  )

  return { name, fullName, fields, nestedMessages, isMapEntry }
}

/**
 * Encode the CodeGeneratorResponse back to protobuf binary.
 */
function encodeResponse(result: PluginResult): Buffer {
  const RespType = pluginRoot.lookupType(
    "google.protobuf.compiler.CodeGeneratorResponse"
  )

  const payload: any = {
    supported_features: 1, // FEATURE_PROTO3_OPTIONAL
    file: result.files.map(f => ({
      name: f.name,
      content: f.content
    }))
  }

  if (result.error) {
    payload.error = result.error
  }

  const msg = RespType.create(payload)
  return Buffer.from(RespType.encode(msg).finish())
}

/**
 * Parse "key=value,key2=value2" parameter string.
 */
function parseParams(param: string): Record<string, string> {
  const result: Record<string, string> = {}
  if (!param) return result

  for (const pair of param.split(",")) {
    const eq = pair.indexOf("=")
    if (eq > 0) {
      result[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim()
    }
  }
  return result
}
