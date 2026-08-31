export interface ControlActor {
  id: string;
  email: string | null;
  name: string | null;
}

export type ActorReference = Pick<ControlActor, "id">;

export interface ControlPrincipal {
  credentialId: string;
  credentialName: string;
  scopes: ReadonlySet<string>;
  actor: ControlActor;
  canDelegateActors: boolean;
  clientAddress: string | null;
}

export interface ControlVariables {
  controlPrincipal: ControlPrincipal;
}
