// taskMachineConfig.ts
import { createMachine } from 'xstate';
// import { TaskSchema } from './types.ts';

const taskMachineConfig = createMachine({
  /** @xstate-layout N4IgpgJg5mDOIC5QBcCGsDWA6ANge1QgEsA7KAYgjxLC1IDc8Na1NcDiyEG8BjVZEWoBtAAwBdMeMSgADnlhFB1GSAAeiAEwBWAMxYALJoCMADgDs2gDQgAnol27RWUaccHT2gJwnNmgwC+ATas2PiEpBRgAE7ReNFYsjgCAGbxALZYoewRXDz8yiRSUqryioWqGgg6+kZmljb2CAbazm7unj7GfoHBINlEEDhg5ACqAAoAIgCCACoAogD6s9MAygDSJUggZUpCJJWI2sbOug12DsdYAGw9xiddPUEh6NgArrIQApGU1LQ8zCyrywHy+gjyJEYBX2xQkpQUexU2yqx1O5yaJjajl0Hm8vk0ulMz36wNB3zI5BicQSSVSGSBbDJ4Kg3EhfG+IgkWzkCIqyMQplMXiw9WsF2qon05ge2k0lgsQtE12J2RSqCIODe0RGACV5rMdQBNbk7Xn7Q4ILzabQuYzaW5ipqmYxYVqiUR2nQKrxKoJ9Eh4CBwVSheHlc38hAAWmujUQMZVwPCnCgYcRB0jRjjCGMXhdhI6eO6-kTbEGwzTfNAVSM1ywFkdl00IruFhMx2uXlL70+5NT212VfUiGugqwmi8o-RWlEzZ07s92m9vr6qvVmu1lYj1cQJ3MdblOLOjctBhbrUXy+VfqAA */
  id: 'task',
  initial: 'loading',
  context: {
    tasks: [],
    tempTask: null,
    error: undefined,
  },
  states: {
    loading: {
      invoke: {
        src: 'fetchTasks',
        onDone: {
          target: 'idle',
          actions: 'assignTasks',
        },
        onError: {
          target: 'failure',
          actions: 'assignError',
        },
      },
    },
    idle: {
      on: {
        UPDATE_TASK: 'updating',
      },
    },
    updating: {
      invoke: {
        src: 'updateTask',
        onDone: 'loading',
        onError: {
          target: 'failure',
          actions: 'assignError',
        },
      },
    },
    failure: {
      on: {
        RETRY: 'loading',
      },
    },
  },
});

export default taskMachineConfig;