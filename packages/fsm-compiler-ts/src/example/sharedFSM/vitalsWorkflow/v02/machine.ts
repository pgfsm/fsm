import { assign, createMachine, fromPromise, createActor, log } from 'xstate';

async function delay(ms: number, errorProbability: number = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (Math.random() < errorProbability) {
        reject({ type: 'ServiceNotAvailable' });
      } else {
        resolve();
      }
    }, ms);
  });
}

const vitalsWorkflow = createMachine(
  {
    /** @xstate-layout N4IgpgJg5mDOIC5QDcCWAXAhgG1gYwAsw8BrAOgGEjSA1DHWAYggHsA7MM1N5FkztFlyFi5KqLpDYCbrzyZ0qdgG0ADAF016xKAAOLWBiVsdIAB6IAbACYy1ywE4ArAGYAjJYAcDy2+svLABYAGhAAT0QAtzJPJwcXT3cAdn84twBfdNDBBhFSSmoSSQZmdk5ZPgF6YUKCiWrpCvlFFTdNDVN9QxaTJHMrJzJLJKckzzcxpOHPTyTQiIR7TzJA1RsnJ09rJJdVBx9M7Ia8sULi3FKOLh5Kshya0TraBpkb5uNla3btPq6jdlMFgQllUZCcbic6wSDjcEzcqic80QE0CZGc7msnkCW3sqk8hxA93wtXEzykl3KN34d2OJLOLyaCg+Lm+nQM-16oCBYzIqiSgWsbh8gUClncDk8SIQ4zBqjlqlhLhSsKCBKJJyeRQajC0bO6xkBiGsziG2JFqy2W0cUqc1lRkOs4P841GE0yWRAbBYEDgpnVhT1HMNCAAtG4pSHLGraY9SVqpIGesHAnNwohRaCMeCESi8dto1INedYHHIImDX0gYF4WQXC44qLLEEHIFwSE0whbdEHU7MXi1u70kA */
    id: 'vitalscheck',
    context: {
      tirePressure: null,
      oilPressure: null,
      coolantLevel: null,
      battery: null
    },
    initial: 'CheckVitals',
    states: {
      CheckVitals: {
        invoke: [
          {
            src: 'checkTirePressure',
            onDone: {
              actions: assign({
                tirePressure: ({ event }) => event.output
              })
            }
          },
          {
            src: 'checkOilPressure',
            onDone: {
              actions: assign({
                oilPressure: ({ event }) => event.output
              })
            }
          },
          {
            src: 'checkCoolantLevel',
            onDone: {
              actions: assign({
                coolantLevel: ({ event }) => event.output
              })
            }
          },
          {
            src: 'checkBattery',
            onDone: {
              actions: assign({
                battery: ({ event }) => event.output
              })
            }
          }
        ],
        always: {
          guard: ({ context }) => {
            return !!(
              context.tirePressure &&
              context.oilPressure &&
              context.coolantLevel &&
              context.battery
            );
          },
          target: 'VitalsChecked'
        }
      },
      VitalsChecked: {
        type: 'final',
        output: ({ context }) => context
      }
    }
  },
  {
    actors: {
      checkTirePressure: fromPromise(async () => {
        console.log('Starting checkTirePressure');
        await delay(1000);
        console.log('Completed checkTirePressure');
        return { value: 100 };
      }),
      checkOilPressure: fromPromise(async () => {
        console.log('Starting checkOilPressure');
        await delay(1500);
        console.log('Completed checkOilPressure');
        return { value: 100 };
      }),
      checkCoolantLevel: fromPromise(async () => {
        console.log('Starting checkCoolantLevel');
        await delay(500);
        console.log('Completed checkCoolantLevel');
        return { value: 100 };
      }),
      checkBattery: fromPromise(async () => {
        console.log('Starting checkBattery');
        await delay(1200);
        console.log('Completed checkBattery');
        return { value: 100 };
      })
    }
  }
);


export default vitalsWorkflow;

