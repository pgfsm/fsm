1. Design you fsm json schema 1.a use existing xstate machine to generate fsm
   json schema 1.b create fsm json schema from screatch

2. generate scalfolding ( base ) code for async operation logic from fsm schema
   json. generate code for invokeObject ( external and internal actors ) based
   on fsmLanguage type.

3. generate scalfolding ( base ) code for sync operation logic from fsm schema
   json.

4. start asyncOperationlet ( worker ). it takes folderpath and lang (comma
   seprated lang string) as argument 4.a loop for each folder in folderpath
   4.a.i validate fsm json 4.a.ii validate all async operation logic fn as per
   its lang type
5. generate scalfolding ( base ) code for sync operation logic from fsm schema
   json.

6. start asyncOperationlet ( worker ). it takes folderpath and lang (comma
   seprated lang string) as argument 4.a loop for each folder in folderpath
   4.a.i validate fsm json 4.a.ii validate all async operation logic fn as per
   its lang type 4.a.iii load async operation logic meta to postgres db json.

7. start asyncOperationlet ( worker ). it takes folderpath and lang (comma
   seprated lang string) as argument 4.a loop for each folder in folderpath
   4.a.i validate fsm json 4.a.ii validate all async operation logic fn as per
   its lang type 4.a.iii load async operation logic meta to postgres db

4.b for each successful 4.a span new process and call processPromiseQueuemessage

4.c register async operation logic process started from 4.b with below meta Data
in async_operation_instance_status table. 5. start fsmlet ( worker ). it takes
folderpath and max fsmworker number\
5.a loop for each folder in folderpath\
5.a.i validate fsm json\
5.a.ii validate all sync operation logic fn.\
5.a.iii verify all internal and external actors ( async operation logic ) is\
present in async_operation_instance_status\
5.a.iv load fsmjson to postgres db

5.b call registerfsmlet

5.c fsmlet loop

5.d heartbeat of fsmlet
