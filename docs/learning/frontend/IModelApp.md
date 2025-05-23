# Frontend Administration with IModelApp

An instance of [IModelApp]($frontend) provides the services needed by the [frontend](../../learning/App.md#app-frontend) in an [interactive](../WriteAnInteractiveApp.md) iTwin.js app. Services include:

* Connecting to an [IModelHost]($backend) to access iModels.
* Management of Views using [ViewManager](./Views.md)
* [Tools](./Tools.md) and [Drawing aids](./DrawingAids.md)
* [Notifications]($frontend:Notifications)
* [Localization support](./Localization.md)

## IModelApp Specializations

To support the various use cases and platforms for iTwin.js frontends, there are specialized "apps" that should be used where appropriate.

> For a given frontend, you will pick *one* class from the following list, and call its `startup` method. The type of `IModelApp` should match the type of [IModelHost](../backend/IModelHost.md) running on your backend.

* **[IModelApp]($frontend)**: must always be initialized. For RPC, connects to previously-initialized `IModelHost`(s) through routing.
  * **[IpcApp]($frontend)**: for frontends with a dedicated [IpcHost]($backend) backend. [IpcApp.startup]($frontend) calls [IModelApp.startup]($frontend). `IpcApp` is abstract and should not be used directly.
    * **`ElectronApp`**: for the frontend of desktop apps running on Windows, Mac, or Linux connected to an `ElectronHost` backend. `ElectronApp.startup` calls [IpcApp.startup]($frontend).
    * **`MobileApp`**: for the frontend of mobile iOS and Android apps. `MobileApp.startup` calls [IpcApp.startup]($frontend).

Applications may customize the behavior of the IModelApp services by providing [IModelAppOptions]($frontend).
