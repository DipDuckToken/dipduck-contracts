/**
 * Erreur attendue (paramètre invalide, garde-fou déclenché, confirmation
 * refusée...). Les scripts l'affichent sans pile d'appels.
 */
export class LaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaunchError";
  }
}

/** Lance `main`, affiche proprement les erreurs et fixe le code de sortie. */
export async function runScript(main: () => Promise<void>): Promise<void> {
  try {
    await main();
  } catch (error) {
    process.exitCode = 1;
    if (error instanceof LaunchError) {
      console.error(`\n✖ ${error.message}\n`);
      return;
    }
    const summary = error instanceof Error ? (error.message.split("\n")[0] ?? error.name) : String(error);
    console.error(`\n✖ Erreur inattendue : ${summary}`);
    console.error(
      "  Le journal n'est modifié qu'à des étapes sûres : si une transaction était en cours,\n" +
        "  relance la même commande pour reprendre son suivi, sans doublon.",
    );
    console.error("\nDétails techniques :");
    console.error(error);
  }
}
