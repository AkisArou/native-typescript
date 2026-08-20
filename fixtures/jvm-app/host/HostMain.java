/** The host: a plain JVM program that loads the compiled-TypeScript library.
 *  The library's verdict ends this process before the sleep matters. */
public class HostMain {
  public static void main(String[] args) throws Exception {
    System.loadLibrary("jvmhosted");
    Thread.sleep(60000);
    System.exit(3); /* the library never completed: its own failure code */
  }
}
