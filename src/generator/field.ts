import { snakeToCamel, codecLibName } from "../util/names.js"
import {
  PROTO_TYPE_MAP,
  WireType,
  fieldTag,
  resolveSolType
} from "./type-map.js"
import { log } from "../util/logger.js"

/** Parsed field descriptor subset needed for codegen. */
export interface FieldInfo {
  name: string
  number: number
  type: number
  typeName?: string
  label: number // 1=optional, 2=required, 3=repeated
  oneofIndex?: number
  mapEntry?: { keyType: number; valueType: number; valueTypeName?: string }
}

/** Check if field is repeated (label == 3). */
export function isRepeated(field: FieldInfo): boolean {
  return field.label === 3
}

/** Check if field is a message type (type == 11). */
export function isMessage(field: FieldInfo): boolean {
  return field.type === 11
}

/**
 * Generate the Solidity struct member declaration for a field.
 */
export function genStructMember(field: FieldInfo): string {
  const solName = snakeToCamel(field.name)
  let solType = resolveSolType(field.type, field.typeName)

  if (field.mapEntry) {
    const keyType = resolveSolType(field.mapEntry.keyType, undefined)
    const valType = resolveSolType(
      field.mapEntry.valueType,
      field.mapEntry.valueTypeName
    )
    // Maps become parallel arrays: keys + values
    return [
      `    ${keyType}[] ${solName}_keys;`,
      `    ${valType}[] ${solName}_values;`
    ].join("\n")
  }

  if (isRepeated(field)) {
    solType = `${solType}[]`
  }

  return `    ${solType} ${solName};`
}

/**
 * Generate encode logic for a single field.
 * Returns Solidity statements that append encoded bytes to a `bytes memory buf`.
 */
export function genFieldEncode(field: FieldInfo): string {
  const solName = snakeToCamel(field.name)
  const typeInfo = PROTO_TYPE_MAP[field.type]

  if (!typeInfo) {
    log.warn(`Skipping unsupported field type ${field.type} for ${field.name}`)
    return `    // TODO: unsupported field type ${field.type} for ${field.name}`
  }

  const tag = fieldTag(
    field.number,
    field.mapEntry ? WireType.LengthDelimited : typeInfo.wireType
  )
  const tagHex = `0x${tag.toString(16)}`

  if (field.mapEntry) {
    return genMapEncode(field, tagHex)
  }

  if (isRepeated(field)) {
    return genRepeatedEncode(field, solName, typeInfo, tagHex)
  }

  if (isMessage(field)) {
    return genMessageEncode(field, solName, tagHex)
  }

  return genScalarEncode(solName, typeInfo, tagHex)
}

/**
 * Generate decode branch for a single field within the tag-dispatch switch.
 * Returns a `case TAG:` block.
 */
export function genFieldDecode(field: FieldInfo): string {
  const solName = snakeToCamel(field.name)
  const typeInfo = PROTO_TYPE_MAP[field.type]

  if (!typeInfo) {
    return `      // TODO: unsupported field type ${field.type} for ${field.name}`
  }

  const tag = fieldTag(
    field.number,
    field.mapEntry ? WireType.LengthDelimited : typeInfo.wireType
  )

  if (field.mapEntry) {
    return genMapDecode(field, solName, tag)
  }

  if (isRepeated(field)) {
    return genRepeatedDecode(field, solName, typeInfo, tag)
  }

  if (isMessage(field)) {
    return genMessageDecode(field, solName, tag)
  }

  return genScalarDecode(solName, typeInfo, tag)
}

// ── Internal codegen helpers ──────────────────────────────────────────

function genScalarEncode(
  solName: string,
  typeInfo: (typeof PROTO_TYPE_MAP)[number],
  tagHex: string
): string {
  return [
    `    buf = abi.encodePacked(buf, ProtobufRuntime._encode_key(${tagHex}));`,
    `    buf = abi.encodePacked(buf, ProtobufRuntime.${typeInfo.encodeFunc}(msg.${solName}));`
  ].join("\n")
}

function genMessageEncode(
  field: FieldInfo,
  solName: string,
  tagHex: string
): string {
  const nestedCodec = codecLibName(resolveSolType(field.type, field.typeName))
  return [
    `    buf = abi.encodePacked(buf, ProtobufRuntime._encode_key(${tagHex}));`,
    `    bytes memory ${solName}_encoded = ${nestedCodec}.encode(msg.${solName});`,
    `    buf = abi.encodePacked(buf, ProtobufRuntime._encode_varint(uint64(${solName}_encoded.length)));`,
    `    buf = abi.encodePacked(buf, ${solName}_encoded);`
  ].join("\n")
}

function genRepeatedEncode(
  field: FieldInfo,
  solName: string,
  typeInfo: (typeof PROTO_TYPE_MAP)[number],
  tagHex: string
): string {
  const loopVar = `_i_${solName}`
  const lines = [
    `    for (uint256 ${loopVar} = 0; ${loopVar} < msg.${solName}.length; ${loopVar}++) {`,
    `      buf = abi.encodePacked(buf, ProtobufRuntime._encode_key(${tagHex}));`
  ]

  if (isMessage(field)) {
    const nestedCodec = codecLibName(resolveSolType(field.type, field.typeName))
    lines.push(
      `      bytes memory _elem = ${nestedCodec}.encode(msg.${solName}[${loopVar}]);`,
      `      buf = abi.encodePacked(buf, ProtobufRuntime._encode_varint(uint64(_elem.length)));`,
      `      buf = abi.encodePacked(buf, _elem);`
    )
  } else {
    lines.push(
      `      buf = abi.encodePacked(buf, ProtobufRuntime.${typeInfo.encodeFunc}(msg.${solName}[${loopVar}]));`
    )
  }

  lines.push(`    }`)
  return lines.join("\n")
}

function genMapEncode(field: FieldInfo, tagHex: string): string {
  const solName = snakeToCamel(field.name)
  const loopVar = `_i_${solName}`
  const me = field.mapEntry!
  const keyInfo = PROTO_TYPE_MAP[me.keyType]
  const valInfo = PROTO_TYPE_MAP[me.valueType]

  const lines = [
    `    for (uint256 ${loopVar} = 0; ${loopVar} < msg.${solName}_keys.length; ${loopVar}++) {`,
    `      bytes memory _entry = "";`,
    `      _entry = abi.encodePacked(_entry, ProtobufRuntime._encode_key(${fieldTag(1, keyInfo.wireType)}));`,
    `      _entry = abi.encodePacked(_entry, ProtobufRuntime.${keyInfo.encodeFunc}(msg.${solName}_keys[${loopVar}]));`
  ]

  if (me.valueType === 11) {
    const nestedCodec = codecLibName(
      resolveSolType(me.valueType, me.valueTypeName)
    )
    lines.push(
      `      bytes memory _val = ${nestedCodec}.encode(msg.${solName}_values[${loopVar}]);`,
      `      _entry = abi.encodePacked(_entry, ProtobufRuntime._encode_key(${fieldTag(2, WireType.LengthDelimited)}));`,
      `      _entry = abi.encodePacked(_entry, ProtobufRuntime._encode_varint(uint64(_val.length)));`,
      `      _entry = abi.encodePacked(_entry, _val);`
    )
  } else {
    lines.push(
      `      _entry = abi.encodePacked(_entry, ProtobufRuntime._encode_key(${fieldTag(2, valInfo.wireType)}));`,
      `      _entry = abi.encodePacked(_entry, ProtobufRuntime.${valInfo.encodeFunc}(msg.${solName}_values[${loopVar}]));`
    )
  }

  lines.push(
    `      buf = abi.encodePacked(buf, ProtobufRuntime._encode_key(${tagHex}));`,
    `      buf = abi.encodePacked(buf, ProtobufRuntime._encode_varint(uint64(_entry.length)));`,
    `      buf = abi.encodePacked(buf, _entry);`,
    `    }`
  )
  return lines.join("\n")
}

function genScalarDecode(
  solName: string,
  typeInfo: (typeof PROTO_TYPE_MAP)[number],
  tag: number
): string {
  return [
    `        case ${tag}:`,
    `          (msg.${solName}, pos) = ProtobufRuntime.${typeInfo.decodeFunc}(data, pos);`,
    `          break;`
  ].join("\n")
}

function genMessageDecode(
  field: FieldInfo,
  solName: string,
  tag: number
): string {
  const nestedCodec = codecLibName(resolveSolType(field.type, field.typeName))
  return [
    `        case ${tag}:`,
    `          {`,
    `            uint64 _len;`,
    `            (_len, pos) = ProtobufRuntime._decode_varint(data, pos);`,
    `            bytes memory _sub = ProtobufRuntime._slice(data, pos, pos + uint256(_len));`,
    `            msg.${solName} = ${nestedCodec}.decode(_sub);`,
    `            pos += uint256(_len);`,
    `          }`,
    `          break;`
  ].join("\n")
}

function genRepeatedDecode(
  field: FieldInfo,
  solName: string,
  typeInfo: (typeof PROTO_TYPE_MAP)[number],
  tag: number
): string {
  if (isMessage(field)) {
    const nestedCodec = codecLibName(resolveSolType(field.type, field.typeName))
    return [
      `        case ${tag}:`,
      `          {`,
      `            uint64 _len;`,
      `            (_len, pos) = ProtobufRuntime._decode_varint(data, pos);`,
      `            bytes memory _sub = ProtobufRuntime._slice(data, pos, pos + uint256(_len));`,
      `            msg.${solName}.push(${nestedCodec}.decode(_sub));`,
      `            pos += uint256(_len);`,
      `          }`,
      `          break;`
    ].join("\n")
  }

  return [
    `        case ${tag}:`,
    `          {`,
    `            ${resolveSolType(field.type, field.typeName)} _elem;`,
    `            (_elem, pos) = ProtobufRuntime.${typeInfo.decodeFunc}(data, pos);`,
    `            msg.${solName}.push(_elem);`,
    `          }`,
    `          break;`
  ].join("\n")
}

function genMapDecode(field: FieldInfo, solName: string, tag: number): string {
  const me = field.mapEntry!
  const keyInfo = PROTO_TYPE_MAP[me.keyType]
  const valInfo = PROTO_TYPE_MAP[me.valueType]
  const keySol = resolveSolType(me.keyType, undefined)
  const valSol = resolveSolType(me.valueType, me.valueTypeName)

  const lines = [
    `        case ${tag}:`,
    `          {`,
    `            uint64 _entryLen;`,
    `            (_entryLen, pos) = ProtobufRuntime._decode_varint(data, pos);`,
    `            uint256 _entryEnd = pos + uint256(_entryLen);`,
    `            ${keySol} _key;`,
    `            ${valSol} _val;`,
    `            while (pos < _entryEnd) {`,
    `              uint64 _entryTag;`,
    `              (_entryTag, pos) = ProtobufRuntime._decode_key(data, pos);`,
    `              if (_entryTag == ${fieldTag(1, keyInfo.wireType)}) {`,
    `                (_key, pos) = ProtobufRuntime.${keyInfo.decodeFunc}(data, pos);`
  ]

  if (me.valueType === 11) {
    const nestedCodec = codecLibName(
      resolveSolType(me.valueType, me.valueTypeName)
    )
    lines.push(
      `              } else if (_entryTag == ${fieldTag(2, WireType.LengthDelimited)}) {`,
      `                uint64 _vLen;`,
      `                (_vLen, pos) = ProtobufRuntime._decode_varint(data, pos);`,
      `                bytes memory _vSub = ProtobufRuntime._slice(data, pos, pos + uint256(_vLen));`,
      `                _val = ${nestedCodec}.decode(_vSub);`,
      `                pos += uint256(_vLen);`
    )
  } else {
    lines.push(
      `              } else if (_entryTag == ${fieldTag(2, valInfo.wireType)}) {`,
      `                (_val, pos) = ProtobufRuntime.${valInfo.decodeFunc}(data, pos);`
    )
  }

  lines.push(
    `              } else {`,
    `                revert("Unknown map entry tag");`,
    `              }`,
    `            }`,
    `            msg.${solName}_keys.push(_key);`,
    `            msg.${solName}_values.push(_val);`,
    `          }`,
    `          break;`
  )
  return lines.join("\n")
}
