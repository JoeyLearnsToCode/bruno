import protobuf from 'protobufjs';
import protoDescriptor from 'protobufjs/ext/descriptor';

/**
 * protobufjs 的 Type.fromDescriptor 不会把 map 字段还原成 MapField，
 * 只留下一个指向 entry 消息的普通 repeated 字段，于是 fromObject 要求传数组：
 *   .pkg.Msg.factors: array expected
 * 只有走 descriptor 的路径（服务端反射）会踩到，.proto 文件路径走的是 parser，map 是好的。
 * 这里把这类字段换回 MapField，map 就能按对象序列化 / 反序列化。
 */
const isMapEntryType = (type) => Boolean(type?.options?.map_entry && type.fields?.key && type.fields?.value);

const restoreMapFields = (root) => {
  root.resolveAll();

  const visitNamespace = (namespace) => {
    Object.values(namespace.nested || {}).forEach((obj) => {
      if (obj instanceof protobuf.Type) {
        obj.fieldsArray.slice().forEach((field) => {
          const entry = field.resolvedType;
          if (!field.repeated || !isMapEntryType(entry)) {
            return;
          }
          const { key, value } = entry.fields;
          obj.remove(field);
          obj.add(
            new protobuf.MapField(
              field.name,
              field.id,
              key.type,
              value.resolvedType ? value.resolvedType.fullName : value.type,
              field.options,
              field.comment
            )
          );
        });
      }
      if (obj.nested) {
        visitNamespace(obj);
      }
    });
  };

  visitNamespace(root);
  root.resolveAll();
  return root;
};

const findMessageFullNames = (messageTypes, prefix) => {
  const names = [];
  (messageTypes || []).forEach((message) => {
    const fullName = prefix ? `${prefix}.${message.name}` : message.name;
    names.push(fullName);
    names.push(...findMessageFullNames(message.nestedType, fullName));
  });
  return names;
};

/**
 * 从 descriptor 里找到消息的完全限定名。同名消息可能存在于多个 package（例如 Empty），
 * 优先取与 service 同一个 package 的那个。
 */
const resolveMessageFullName = (files, messageName, methodPath) => {
  const servicePath = (methodPath || '').slice(1, (methodPath || '').lastIndexOf('/'));
  const servicePackage = servicePath.slice(0, Math.max(servicePath.lastIndexOf('.'), 0));

  const candidates = [];
  files.forEach((file) => {
    findMessageFullNames(file.messageType, file.package || '').forEach((fullName) => {
      if (fullName.split('.').pop() === messageName) {
        candidates.push(fullName);
      }
    });
  });

  return candidates.find((name) => name.startsWith(`${servicePackage}.`)) ?? candidates[0];
};

/**
 * 给服务端反射拿到的 method 定义补上 map 字段支持。
 * 失败时原样返回，不影响原有行为。
 *
 * @param {Object} method - @grpc/proto-loader 的 MethodDefinition
 * @param {Object} options - 传给 protobufjs toObject 的选项（反序列化用）
 * @returns {Object} method
 */
export const withMapFieldSupport = (method, options = {}) => {
  const fileDescriptorProtos = method?.requestType?.fileDescriptorProtos;
  if (!Array.isArray(fileDescriptorProtos) || !fileDescriptorProtos.length) {
    return method;
  }

  try {
    const files = fileDescriptorProtos.map((buffer) => protoDescriptor.FileDescriptorProto.decode(Buffer.from(buffer)));
    const root = restoreMapFields(protobuf.Root.fromDescriptor({ file: files }));

    const requestType = root.lookupType(resolveMessageFullName(files, method.requestType.type?.name, method.path));
    const responseType = root.lookupType(resolveMessageFullName(files, method.responseType.type?.name, method.path));

    return {
      ...method,
      requestSerialize: (arg) => requestType.encode(requestType.fromObject(arg)).finish(),
      responseDeserialize: (buffer) => responseType.toObject(responseType.decode(buffer), options)
    };
  } catch (error) {
    console.error('Failed to restore map fields for gRPC method:', error);
    return method;
  }
};
