package fixture;

/** Extends Widget so the ancestry-selection rule has a case to catch. */
public class Button extends Widget implements Clickable {
  public Button(String label) {
    super(0);
  }

  public void click() {}

  @Override
  public void onClick(Button source) {}
}
