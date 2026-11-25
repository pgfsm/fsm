from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class OperationType(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    OPERATION_TYPE_UNSPECIFIED: _ClassVar[OperationType]
    OPERATION_TYPE_ACTION: _ClassVar[OperationType]
    OPERATION_TYPE_GUARD: _ClassVar[OperationType]
    OPERATION_TYPE_DELAY: _ClassVar[OperationType]
    OPERATION_TYPE_INPUT: _ClassVar[OperationType]

class RegistrationProblemKind(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    REGISTRATION_PROBLEM_KIND_UNSPECIFIED: _ClassVar[RegistrationProblemKind]
    REGISTRATION_PROBLEM_KIND_MISSING: _ClassVar[RegistrationProblemKind]
    REGISTRATION_PROBLEM_KIND_AMBIGUOUS: _ClassVar[RegistrationProblemKind]
    REGISTRATION_PROBLEM_KIND_DRIFTED: _ClassVar[RegistrationProblemKind]
    REGISTRATION_PROBLEM_KIND_UNDIGESTED: _ClassVar[RegistrationProblemKind]
    REGISTRATION_PROBLEM_KIND_UNIMPLEMENTED: _ClassVar[RegistrationProblemKind]
    REGISTRATION_PROBLEM_KIND_DUPLICATE: _ClassVar[RegistrationProblemKind]
    REGISTRATION_PROBLEM_KIND_UNEXPECTED_LANGUAGE: _ClassVar[RegistrationProblemKind]
    REGISTRATION_PROBLEM_KIND_PROTOCOL_VERSION: _ClassVar[RegistrationProblemKind]
OPERATION_TYPE_UNSPECIFIED: OperationType
OPERATION_TYPE_ACTION: OperationType
OPERATION_TYPE_GUARD: OperationType
OPERATION_TYPE_DELAY: OperationType
OPERATION_TYPE_INPUT: OperationType
REGISTRATION_PROBLEM_KIND_UNSPECIFIED: RegistrationProblemKind
REGISTRATION_PROBLEM_KIND_MISSING: RegistrationProblemKind
REGISTRATION_PROBLEM_KIND_AMBIGUOUS: RegistrationProblemKind
REGISTRATION_PROBLEM_KIND_DRIFTED: RegistrationProblemKind
REGISTRATION_PROBLEM_KIND_UNDIGESTED: RegistrationProblemKind
REGISTRATION_PROBLEM_KIND_UNIMPLEMENTED: RegistrationProblemKind
REGISTRATION_PROBLEM_KIND_DUPLICATE: RegistrationProblemKind
REGISTRATION_PROBLEM_KIND_UNEXPECTED_LANGUAGE: RegistrationProblemKind
REGISTRATION_PROBLEM_KIND_PROTOCOL_VERSION: RegistrationProblemKind

class Operation(_message.Message):
    __slots__ = ("type", "name")
    TYPE_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    type: OperationType
    name: str
    def __init__(self, type: _Optional[_Union[OperationType, str]] = ..., name: _Optional[str] = ...) -> None: ...

class FsmVersion(_message.Message):
    __slots__ = ("fsm_name", "fsm_version", "fsm_json_digest", "operations")
    FSM_NAME_FIELD_NUMBER: _ClassVar[int]
    FSM_VERSION_FIELD_NUMBER: _ClassVar[int]
    FSM_JSON_DIGEST_FIELD_NUMBER: _ClassVar[int]
    OPERATIONS_FIELD_NUMBER: _ClassVar[int]
    fsm_name: str
    fsm_version: str
    fsm_json_digest: str
    operations: _containers.RepeatedCompositeFieldContainer[Operation]
    def __init__(self, fsm_name: _Optional[str] = ..., fsm_version: _Optional[str] = ..., fsm_json_digest: _Optional[str] = ..., operations: _Optional[_Iterable[_Union[Operation, _Mapping]]] = ...) -> None: ...

class Register(_message.Message):
    __slots__ = ("executor_id", "language", "protocol_version", "sdk_version", "fsm_versions")
    EXECUTOR_ID_FIELD_NUMBER: _ClassVar[int]
    LANGUAGE_FIELD_NUMBER: _ClassVar[int]
    PROTOCOL_VERSION_FIELD_NUMBER: _ClassVar[int]
    SDK_VERSION_FIELD_NUMBER: _ClassVar[int]
    FSM_VERSIONS_FIELD_NUMBER: _ClassVar[int]
    executor_id: str
    language: str
    protocol_version: str
    sdk_version: str
    fsm_versions: _containers.RepeatedCompositeFieldContainer[FsmVersion]
    def __init__(self, executor_id: _Optional[str] = ..., language: _Optional[str] = ..., protocol_version: _Optional[str] = ..., sdk_version: _Optional[str] = ..., fsm_versions: _Optional[_Iterable[_Union[FsmVersion, _Mapping]]] = ...) -> None: ...

class RegistrationProblem(_message.Message):
    __slots__ = ("kind", "fsm_name", "fsm_version", "message")
    KIND_FIELD_NUMBER: _ClassVar[int]
    FSM_NAME_FIELD_NUMBER: _ClassVar[int]
    FSM_VERSION_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    kind: RegistrationProblemKind
    fsm_name: str
    fsm_version: str
    message: str
    def __init__(self, kind: _Optional[_Union[RegistrationProblemKind, str]] = ..., fsm_name: _Optional[str] = ..., fsm_version: _Optional[str] = ..., message: _Optional[str] = ...) -> None: ...

class RegisterAck(_message.Message):
    __slots__ = ("accepted", "engine_protocol_version", "problems")
    ACCEPTED_FIELD_NUMBER: _ClassVar[int]
    ENGINE_PROTOCOL_VERSION_FIELD_NUMBER: _ClassVar[int]
    PROBLEMS_FIELD_NUMBER: _ClassVar[int]
    accepted: bool
    engine_protocol_version: str
    problems: _containers.RepeatedCompositeFieldContainer[RegistrationProblem]
    def __init__(self, accepted: _Optional[bool] = ..., engine_protocol_version: _Optional[str] = ..., problems: _Optional[_Iterable[_Union[RegistrationProblem, _Mapping]]] = ...) -> None: ...

class Heartbeat(_message.Message):
    __slots__ = ("executor_id",)
    EXECUTOR_ID_FIELD_NUMBER: _ClassVar[int]
    executor_id: str
    def __init__(self, executor_id: _Optional[str] = ...) -> None: ...

class Unregister(_message.Message):
    __slots__ = ("executor_id",)
    EXECUTOR_ID_FIELD_NUMBER: _ClassVar[int]
    executor_id: str
    def __init__(self, executor_id: _Optional[str] = ...) -> None: ...

class CallMeta(_message.Message):
    __slots__ = ("instance_id", "attempt")
    INSTANCE_ID_FIELD_NUMBER: _ClassVar[int]
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    instance_id: str
    attempt: int
    def __init__(self, instance_id: _Optional[str] = ..., attempt: _Optional[int] = ...) -> None: ...

class Call(_message.Message):
    __slots__ = ("call_id", "fsm_name", "fsm_version", "operation_type", "operation_name", "context_json", "event_json", "params_json", "meta", "deadline_ms")
    CALL_ID_FIELD_NUMBER: _ClassVar[int]
    FSM_NAME_FIELD_NUMBER: _ClassVar[int]
    FSM_VERSION_FIELD_NUMBER: _ClassVar[int]
    OPERATION_TYPE_FIELD_NUMBER: _ClassVar[int]
    OPERATION_NAME_FIELD_NUMBER: _ClassVar[int]
    CONTEXT_JSON_FIELD_NUMBER: _ClassVar[int]
    EVENT_JSON_FIELD_NUMBER: _ClassVar[int]
    PARAMS_JSON_FIELD_NUMBER: _ClassVar[int]
    META_FIELD_NUMBER: _ClassVar[int]
    DEADLINE_MS_FIELD_NUMBER: _ClassVar[int]
    call_id: str
    fsm_name: str
    fsm_version: str
    operation_type: OperationType
    operation_name: str
    context_json: str
    event_json: str
    params_json: str
    meta: CallMeta
    deadline_ms: int
    def __init__(self, call_id: _Optional[str] = ..., fsm_name: _Optional[str] = ..., fsm_version: _Optional[str] = ..., operation_type: _Optional[_Union[OperationType, str]] = ..., operation_name: _Optional[str] = ..., context_json: _Optional[str] = ..., event_json: _Optional[str] = ..., params_json: _Optional[str] = ..., meta: _Optional[_Union[CallMeta, _Mapping]] = ..., deadline_ms: _Optional[int] = ...) -> None: ...

class NoValue(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class CallError(_message.Message):
    __slots__ = ("error_type", "message", "stack")
    ERROR_TYPE_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    STACK_FIELD_NUMBER: _ClassVar[int]
    error_type: str
    message: str
    stack: str
    def __init__(self, error_type: _Optional[str] = ..., message: _Optional[str] = ..., stack: _Optional[str] = ...) -> None: ...

class CallResult(_message.Message):
    __slots__ = ("call_id", "value_json", "no_value", "error", "duration_ms")
    CALL_ID_FIELD_NUMBER: _ClassVar[int]
    VALUE_JSON_FIELD_NUMBER: _ClassVar[int]
    NO_VALUE_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    DURATION_MS_FIELD_NUMBER: _ClassVar[int]
    call_id: str
    value_json: str
    no_value: NoValue
    error: CallError
    duration_ms: int
    def __init__(self, call_id: _Optional[str] = ..., value_json: _Optional[str] = ..., no_value: _Optional[_Union[NoValue, _Mapping]] = ..., error: _Optional[_Union[CallError, _Mapping]] = ..., duration_ms: _Optional[int] = ...) -> None: ...

class Shutdown(_message.Message):
    __slots__ = ("reason",)
    REASON_FIELD_NUMBER: _ClassVar[int]
    reason: str
    def __init__(self, reason: _Optional[str] = ...) -> None: ...

class SessionRequest(_message.Message):
    __slots__ = ("register", "heartbeat", "call_result", "unregister")
    REGISTER_FIELD_NUMBER: _ClassVar[int]
    HEARTBEAT_FIELD_NUMBER: _ClassVar[int]
    CALL_RESULT_FIELD_NUMBER: _ClassVar[int]
    UNREGISTER_FIELD_NUMBER: _ClassVar[int]
    register: Register
    heartbeat: Heartbeat
    call_result: CallResult
    unregister: Unregister
    def __init__(self, register: _Optional[_Union[Register, _Mapping]] = ..., heartbeat: _Optional[_Union[Heartbeat, _Mapping]] = ..., call_result: _Optional[_Union[CallResult, _Mapping]] = ..., unregister: _Optional[_Union[Unregister, _Mapping]] = ...) -> None: ...

class SessionResponse(_message.Message):
    __slots__ = ("register_ack", "call", "shutdown")
    REGISTER_ACK_FIELD_NUMBER: _ClassVar[int]
    CALL_FIELD_NUMBER: _ClassVar[int]
    SHUTDOWN_FIELD_NUMBER: _ClassVar[int]
    register_ack: RegisterAck
    call: Call
    shutdown: Shutdown
    def __init__(self, register_ack: _Optional[_Union[RegisterAck, _Mapping]] = ..., call: _Optional[_Union[Call, _Mapping]] = ..., shutdown: _Optional[_Union[Shutdown, _Mapping]] = ...) -> None: ...
