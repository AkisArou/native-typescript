package android.annotation;

/**
 * A stand-in for the platform's own annotation, declared here so a fixture
 * class file can STATE non-nullness without the Android SDK being present.
 *
 * The binary name is what matters and it is the real one: ingestion reads
 * `Landroid/annotation/NonNull;` out of the constant pool and never resolves
 * the annotation type, so a class file built against this declaration is
 * byte-for-byte the same evidence as one built against the platform's.
 *
 * Retention is left at its default, CLASS, which is what android.jar
 * carries — the annotation lands in RuntimeInvisibleAnnotations. Nullable
 * deliberately uses RUNTIME so the two attribute families are both covered.
 */
public @interface NonNull {}
