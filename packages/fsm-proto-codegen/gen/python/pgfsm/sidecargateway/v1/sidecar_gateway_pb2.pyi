from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class RegisteredActor(_message.Message):
    __slots__ = ("parent_fsm_name", "parent_fsm_version", "async_operation_type", "async_operation_name", "async_operation_version", "async_operation_language", "timeout_ms", "description", "max_concurrency")
    PARENT_FSM_NAME_FIELD_NUMBER: _ClassVar[int]
    PARENT_FSM_VERSION_FIELD_NUMBER: _ClassVar[int]
    ASYNC_OPERATION_TYPE_FIELD_NUMBER: _ClassVar[int]
    ASYNC_OPERATION_NAME_FIELD_NUMBER: _ClassVar[int]
    ASYNC_OPERATION_VERSION_FIELD_NUMBER: _ClassVar[int]
    ASYNC_OPERATION_LANGUAGE_FIELD_NUMBER: _ClassVar[int]
    TIMEOUT_MS_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    MAX_CONCURRENCY_FIELD_NUMBER: _ClassVar[int]
    parent_fsm_name: str
    parent_fsm_version: str
    async_operation_type: str
    async_operation_name: str
    async_operation_version: str
    async_operation_language: str
    timeout_ms: int
    description: str
    max_concurrency: int
    def __init__(self, parent_fsm_name: _Optional[str] = ..., parent_fsm_version: _Optional[str] = ..., async_operation_type: _Optional[str] = ..., async_operation_name: _Optional[str] = ..., async_operation_version: _Optional[str] = ..., async_operation_language: _Optional[str] = ..., timeout_ms: _Optional[int] = ..., description: _Optional[str] = ..., max_concurrency: _Optional[int] = ...) -> None: ...

class Register(_message.Message):
    __slots__ = ("worker_id", "language", "protocol_version", "actors")
    WORKER_ID_FIELD_NUMBER: _ClassVar[int]
    LANGUAGE_FIELD_NUMBER: _ClassVar[int]
    PROTOCOL_VERSION_FIELD_NUMBER: _ClassVar[int]
    ACTORS_FIELD_NUMBER: _ClassVar[int]
    worker_id: str
    language: str
    protocol_version: str
    actors: _containers.RepeatedCompositeFieldContainer[RegisteredActor]
    def __init__(self, worker_id: _Optional[str] = ..., language: _Optional[str] = ..., protocol_version: _Optional[str] = ..., actors: _Optional[_Iterable[_Union[RegisteredActor, _Mapping]]] = ...) -> None: ...

class RegisterAck(_message.Message):
    __slots__ = ("accepted", "gateway_protocol_version", "registered_actors", "rejected_actors")
    ACCEPTED_FIELD_NUMBER: _ClassVar[int]
    GATEWAY_PROTOCOL_VERSION_FIELD_NUMBER: _ClassVar[int]
    REGISTERED_ACTORS_FIELD_NUMBER: _ClassVar[int]
    REJECTED_ACTORS_FIELD_NUMBER: _ClassVar[int]
    accepted: bool
    gateway_protocol_version: str
    registered_actors: _containers.RepeatedScalarFieldContainer[str]
    rejected_actors: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, accepted: _Optional[bool] = ..., gateway_protocol_version: _Optional[str] = ..., registered_actors: _Optional[_Iterable[str]] = ..., rejected_actors: _Optional[_Iterable[str]] = ...) -> None: ...

class Heartbeat(_message.Message):
    __slots__ = ("worker_id",)
    WORKER_ID_FIELD_NUMBER: _ClassVar[int]
    worker_id: str
    def __init__(self, worker_id: _Optional[str] = ...) -> None: ...

class Invoke(_message.Message):
    __slots__ = ("invoke_id", "parent_fsm_name", "parent_fsm_version", "async_operation_type", "async_operation_name", "async_operation_version", "async_operation_language", "input_json", "instance_id", "correlation_id", "timeout_ms", "deadline_unix_ms")
    INVOKE_ID_FIELD_NUMBER: _ClassVar[int]
    PARENT_FSM_NAME_FIELD_NUMBER: _ClassVar[int]
    PARENT_FSM_VERSION_FIELD_NUMBER: _ClassVar[int]
    ASYNC_OPERATION_TYPE_FIELD_NUMBER: _ClassVar[int]
    ASYNC_OPERATION_NAME_FIELD_NUMBER: _ClassVar[int]
    ASYNC_OPERATION_VERSION_FIELD_NUMBER: _ClassVar[int]
    ASYNC_OPERATION_LANGUAGE_FIELD_NUMBER: _ClassVar[int]
    INPUT_JSON_FIELD_NUMBER: _ClassVar[int]
    INSTANCE_ID_FIELD_NUMBER: _ClassVar[int]
    CORRELATION_ID_FIELD_NUMBER: _ClassVar[int]
    TIMEOUT_MS_FIELD_NUMBER: _ClassVar[int]
    DEADLINE_UNIX_MS_FIELD_NUMBER: _ClassVar[int]
    invoke_id: str
    parent_fsm_name: str
    parent_fsm_version: str
    async_operation_type: str
    async_operation_name: str
    async_operation_version: str
    async_operation_language: str
    input_json: str
    instance_id: str
    correlation_id: str
    timeout_ms: int
    deadline_unix_ms: int
    def __init__(self, invoke_id: _Optional[str] = ..., parent_fsm_name: _Optional[str] = ..., parent_fsm_version: _Optional[str] = ..., async_operation_type: _Optional[str] = ..., async_operation_name: _Optional[str] = ..., async_operation_version: _Optional[str] = ..., async_operation_language: _Optional[str] = ..., input_json: _Optional[str] = ..., instance_id: _Optional[str] = ..., correlation_id: _Optional[str] = ..., timeout_ms: _Optional[int] = ..., deadline_unix_ms: _Optional[int] = ...) -> None: ...

class InvokeResult(_message.Message):
    __slots__ = ("invoke_id", "output_json", "duration_ms")
    INVOKE_ID_FIELD_NUMBER: _ClassVar[int]
    OUTPUT_JSON_FIELD_NUMBER: _ClassVar[int]
    DURATION_MS_FIELD_NUMBER: _ClassVar[int]
    invoke_id: str
    output_json: str
    duration_ms: int
    def __init__(self, invoke_id: _Optional[str] = ..., output_json: _Optional[str] = ..., duration_ms: _Optional[int] = ...) -> None: ...

class InvokeErrorDetail(_message.Message):
    __slots__ = ("code", "message", "retriable")
    CODE_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    RETRIABLE_FIELD_NUMBER: _ClassVar[int]
    code: str
    message: str
    retriable: bool
    def __init__(self, code: _Optional[str] = ..., message: _Optional[str] = ..., retriable: _Optional[bool] = ...) -> None: ...

class InvokeError(_message.Message):
    __slots__ = ("invoke_id", "error", "duration_ms")
    INVOKE_ID_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    DURATION_MS_FIELD_NUMBER: _ClassVar[int]
    invoke_id: str
    error: InvokeErrorDetail
    duration_ms: int
    def __init__(self, invoke_id: _Optional[str] = ..., error: _Optional[_Union[InvokeErrorDetail, _Mapping]] = ..., duration_ms: _Optional[int] = ...) -> None: ...

class Cancel(_message.Message):
    __slots__ = ("invoke_id",)
    INVOKE_ID_FIELD_NUMBER: _ClassVar[int]
    invoke_id: str
    def __init__(self, invoke_id: _Optional[str] = ...) -> None: ...

class Unregister(_message.Message):
    __slots__ = ("worker_id",)
    WORKER_ID_FIELD_NUMBER: _ClassVar[int]
    worker_id: str
    def __init__(self, worker_id: _Optional[str] = ...) -> None: ...

class SessionRequest(_message.Message):
    __slots__ = ("register", "heartbeat", "invoke_result", "invoke_error", "unregister")
    REGISTER_FIELD_NUMBER: _ClassVar[int]
    HEARTBEAT_FIELD_NUMBER: _ClassVar[int]
    INVOKE_RESULT_FIELD_NUMBER: _ClassVar[int]
    INVOKE_ERROR_FIELD_NUMBER: _ClassVar[int]
    UNREGISTER_FIELD_NUMBER: _ClassVar[int]
    register: Register
    heartbeat: Heartbeat
    invoke_result: InvokeResult
    invoke_error: InvokeError
    unregister: Unregister
    def __init__(self, register: _Optional[_Union[Register, _Mapping]] = ..., heartbeat: _Optional[_Union[Heartbeat, _Mapping]] = ..., invoke_result: _Optional[_Union[InvokeResult, _Mapping]] = ..., invoke_error: _Optional[_Union[InvokeError, _Mapping]] = ..., unregister: _Optional[_Union[Unregister, _Mapping]] = ...) -> None: ...

class SessionResponse(_message.Message):
    __slots__ = ("register_ack", "invoke", "cancel")
    REGISTER_ACK_FIELD_NUMBER: _ClassVar[int]
    INVOKE_FIELD_NUMBER: _ClassVar[int]
    CANCEL_FIELD_NUMBER: _ClassVar[int]
    register_ack: RegisterAck
    invoke: Invoke
    cancel: Cancel
    def __init__(self, register_ack: _Optional[_Union[RegisterAck, _Mapping]] = ..., invoke: _Optional[_Union[Invoke, _Mapping]] = ..., cancel: _Optional[_Union[Cancel, _Mapping]] = ...) -> None: ...
